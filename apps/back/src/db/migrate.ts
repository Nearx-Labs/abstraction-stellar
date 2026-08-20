// Runner de migração mínimo: aplica os .sql de ./migrations em ordem
// lexicográfica, cada um na sua transação, registrando o que já rodou.
//
// Roda no boot, ANTES do listen. O advisory lock garante que subir N réplicas
// ao mesmo tempo não aplique a mesma migração duas vezes: quem não pegar o
// lock espera e, ao entrar, vê a migração já registrada.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pool } from './pool.js';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_ID = 8_170_244_193_001n; // arbitrário, só precisa ser estável

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID.toString()]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations',
      )).rows.map((r) => [r.name, r.checksum]),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const name of files) {
      const sql = await readFile(`${MIGRATIONS_DIR}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = applied.get(name);

      if (previous === checksum) continue;
      if (previous !== undefined) {
        // Editar uma migração já aplicada produz drift silencioso entre
        // ambientes. Melhor parar e exigir uma migração nova.
        throw new Error(
          `migração ${name} já aplicada com checksum ${previous}, mas o arquivo mudou ` +
            `(${checksum}). Crie uma migração nova em vez de editar esta.`,
        );
      }

      logger.info({ migration: name }, 'aplicando migração');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID.toString()]).catch(() => {});
    client.release();
  }
}

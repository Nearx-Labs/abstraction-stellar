import pg from 'pg';
import { env } from '../env.js';

// bigint (int8) chega como string por default no node-postgres, porque não
// cabe em Number. Aqui tudo que é stroop é bigint no domínio, então
// convertemos explicitamente em vez de deixar string vazar pelo código.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Roda `fn` dentro de uma transação, com rollback em qualquer exceção. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

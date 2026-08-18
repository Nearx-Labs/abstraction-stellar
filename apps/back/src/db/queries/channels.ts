// Pool de contas pagadoras com lease.
//
// Duas transações submetidas ao mesmo tempo pela mesma conta colidem no
// sequence number — e o relayer antigo tinha exatamente um fee payer, sem fila
// nem lock. Só o caminho {func, auth} e o outbox consomem sequence (um
// fee-bump não consome o do feeSource), então basta um pool para esses.
//
// `FOR UPDATE SKIP LOCKED` é o padrão de fila do Postgres: cada réplica pega
// um channel diferente sem bloquear as outras.
import { pool } from '../pool.js';
import { keypairFor, type Role } from '../../chain/keys.js';
import type { Keypair } from '@stellar/stellar-sdk';

export const LEASE_SECONDS = 90;

export class NoChannelAvailableError extends Error {
  readonly code = 'NO_CHANNEL_AVAILABLE';
  constructor() {
    super('nenhuma conta pagadora livre no momento');
  }
}

export interface Lease {
  id: string;
  publicKey: string;
  keypair: Keypair;
}

/**
 * Registra/atualiza as contas de cada papel. Idempotente, roda no boot.
 *
 * O segundo passo importa tanto quanto o primeiro: uma chave que saiu da
 * configuração deixa a linha para trás, e essa linha continua elegível a lease
 * — aí `keypairFor` estoura porque o segredo não existe mais no processo.
 * Desativar o que não está mais configurado evita envenenar o pool.
 */
export async function syncChannels(
  keys: Array<{ role: Role; publicKey: string }>,
): Promise<void> {
  for (const { role, publicKey } of keys) {
    await pool.query(
      `INSERT INTO fee_payer_channels (public_key, role, state)
       VALUES ($1, $2, 'active')
       ON CONFLICT (public_key)
       DO UPDATE SET role = EXCLUDED.role, state = 'active', updated_at = now()`,
      [publicKey, role],
    );
  }

  await pool.query(
    `UPDATE fee_payer_channels
        SET state = 'disabled', leased_until = NULL,
            last_error = 'chave não está mais configurada neste processo',
            updated_at = now()
      WHERE state <> 'disabled' AND public_key <> ALL($1::text[])`,
    [keys.map((key) => key.publicKey)],
  );
}

/** Toma um channel livre. Lança `NoChannelAvailableError` se todos estão ocupados. */
export async function acquire(role: Role = 'channel'): Promise<Lease> {
  const res = await pool.query<{ id: string; public_key: string }>(
    `UPDATE fee_payer_channels
        SET leased_until = now() + ($2 || ' seconds')::interval,
            updated_at   = now()
      WHERE id = (
        SELECT id FROM fee_payer_channels
         WHERE role = $1 AND state = 'active'
           AND (leased_until IS NULL OR leased_until < now())
         ORDER BY leased_until NULLS FIRST
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, public_key`,
    [role, LEASE_SECONDS],
  );

  const row = res.rows[0];
  if (!row) throw new NoChannelAvailableError();
  return { id: row.id, publicKey: row.public_key, keypair: keypairFor(row.public_key) };
}

export async function release(leaseId: string, error?: string): Promise<void> {
  await pool.query(
    `UPDATE fee_payer_channels
        SET leased_until = NULL, last_error = $2, updated_at = now()
      WHERE id = $1`,
    [leaseId, error ?? null],
  );
}

/** Executa `fn` com um channel tomado, devolvendo o lease no fim. */
export async function withChannel<T>(
  role: Role,
  fn: (lease: Lease) => Promise<T>,
): Promise<T> {
  const lease = await acquire(role);
  try {
    const out = await fn(lease);
    await release(lease.id);
    return out;
  } catch (err) {
    await release(lease.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function recordBalance(publicKey: string, balance: bigint): Promise<void> {
  await pool.query(
    'UPDATE fee_payer_channels SET balance_stroops = $2, updated_at = now() WHERE public_key = $1',
    [publicKey, balance.toString()],
  );
}

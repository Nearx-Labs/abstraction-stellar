import { pool } from '../pool.js';

export type FaucetState = 'pending' | 'xlm_sent' | 'allowance_set' | 'done' | 'failed';

export interface FaucetClaim {
  id: string;
  state: FaucetState;
  xlmTxHash: string | null;
  createdAt: Date;
  completedAt: Date | null;
  error: string | null;
}

export interface CooldownInfo {
  blocked: boolean;
  nextAvailableAt: Date | null;
  last: FaucetClaim | null;
}

const COLUMNS = 'id, state, xlm_tx_hash, created_at, completed_at, error';

const map = (r: {
  id: string;
  state: FaucetState;
  xlm_tx_hash: string | null;
  created_at: Date;
  completed_at: Date | null;
  error: string | null;
}): FaucetClaim => ({
  id: r.id,
  state: r.state,
  xlmTxHash: r.xlm_tx_hash,
  createdAt: r.created_at,
  completedAt: r.completed_at,
  error: r.error,
});

export async function lastClaim(accountId: string): Promise<FaucetClaim | null> {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM faucet_claims
      WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [accountId],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

export async function cooldown(accountId: string, hours: number): Promise<CooldownInfo> {
  const last = await lastClaim(accountId);
  if (!last) return { blocked: false, nextAvailableAt: null, last: null };

  // Claim que falhou não gasta o cooldown — seria punir o usuário por um
  // problema nosso.
  if (last.state === 'failed') return { blocked: false, nextAvailableAt: null, last };

  const next = new Date(last.createdAt.getTime() + hours * 3600_000);
  return { blocked: next > new Date(), nextAvailableAt: next, last };
}

export class ClaimInFlightError extends Error {
  readonly code = 'FAUCET_IN_FLIGHT';
  constructor() {
    super('já existe um pedido de faucet em andamento para esta conta');
  }
}

/**
 * Abre um claim. O índice único parcial em `(account_id) WHERE state IN
 * (em voo)` faz o duplo clique — e o duplo pod — falhar aqui em vez de mandar
 * XLM duas vezes.
 */
export async function open(input: {
  appId: string;
  accountId: string;
  smartAccount: string;
  amountStroops: bigint;
  requesterIp?: string;
}): Promise<string> {
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO faucet_claims (app_id, account_id, smart_account, amount_stroops, requester_ip)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        input.appId,
        input.accountId,
        input.smartAccount,
        input.amountStroops.toString(),
        input.requesterIp ?? null,
      ],
    );
    return res.rows[0]!.id;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ClaimInFlightError();
    throw error;
  }
}

export async function markXlmSent(id: string, txHash: string): Promise<void> {
  await pool.query(
    `UPDATE faucet_claims SET state = 'xlm_sent', xlm_tx_hash = $2 WHERE id = $1`,
    [id, txHash],
  );
}

export async function attachAllowanceJob(id: string, outboxId: string | null): Promise<void> {
  await pool.query(
    `UPDATE faucet_claims
        SET state = 'allowance_set', allowance_outbox_id = $2
      WHERE id = $1`,
    [id, outboxId],
  );
}

export async function markDone(id: string): Promise<void> {
  await pool.query(
    `UPDATE faucet_claims SET state = 'done', completed_at = now() WHERE id = $1`,
    [id],
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE faucet_claims SET state = 'failed', error = $2, completed_at = now() WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
}

export async function byId(id: string): Promise<FaucetClaim | null> {
  const res = await pool.query(`SELECT ${COLUMNS} FROM faucet_claims WHERE id = $1`, [id]);
  const row = res.rows[0];
  return row ? map(row) : null;
}

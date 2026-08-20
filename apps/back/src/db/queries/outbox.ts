// Outbox de escritas no Treasury.
//
// O `debitTreasury` antigo era disparado como `void debitTreasury(...)`: a
// resposta HTTP saía antes de ele rodar, ele nunca poleava o resultado
// (`sendTransaction` devolve PENDING; um revert depois era invisível) e o erro
// morria num console.error. Sem retry, sem fila, sem persistência — débito
// perdido não deixava rastro.
//
// Agora toda escrita vira linha aqui e um worker a leva até `done` ou `dead`.
import type { PoolClient } from 'pg';
import { pool } from '../pool.js';

export type OutboxKind = 'consume' | 'set_allowance' | 'allow_target' | 'withdraw';

export interface EnqueueInput {
  appId: string;
  kind: OutboxKind;
  sponsorshipId?: string | null;
  payload: Record<string, unknown>;
  /** Chave natural da operação; `ON CONFLICT DO NOTHING` a torna idempotente. */
  dedupeKey: string;
}

export interface OutboxJob {
  id: string;
  appId: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function enqueue(
  client: PoolClient | typeof pool,
  input: EnqueueInput,
): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO treasury_outbox (app_id, kind, sponsorship_id, payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.appId,
      input.kind,
      input.sponsorshipId ?? null,
      JSON.stringify(input.payload),
      input.dedupeKey,
    ],
  );
  return res.rows[0]?.id ?? null;
}

/** Toma até `limit` jobs prontos, marcando-os `in_flight`. */
export async function claim(limit = 5): Promise<OutboxJob[]> {
  const res = await pool.query(
    `UPDATE treasury_outbox
        SET state = 'in_flight', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM treasury_outbox
         WHERE state IN ('pending', 'failed') AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1)
      RETURNING id, app_id, kind, payload, attempts`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    appId: r.app_id,
    kind: r.kind,
    payload: r.payload,
    attempts: r.attempts,
  }));
}

export async function succeed(id: string, txHash: string): Promise<void> {
  await pool.query(
    `UPDATE treasury_outbox
        SET state = 'done', tx_hash = $2, done_at = now(), last_error = NULL
      WHERE id = $1`,
    [id, txHash],
  );
}

const MAX_ATTEMPTS = 8;
/** Uma condição que outro processo conserta merece muito mais paciência. */
const MAX_ATTEMPTS_TRANSIENT = 40;

/**
 * Erros que passam sozinhos, e por isso não devem matar o job.
 *
 * NoAllowance (5101) é o caso real: um débito feito antes de a conta ter
 * allowance no Treasury falharia 8 vezes e morreria — perdendo o registro
 * auditável — mesmo com o reconciliador de allowance prestes a provisionar.
 */
const TRANSIENT_CONTRACT_ERRORS = ['#5101'];

/** Backoff exponencial com teto; depois de MAX_ATTEMPTS a linha vira `dead`. */
export async function fail(id: string, attempts: number, error: string): Promise<void> {
  const transient = TRANSIENT_CONTRACT_ERRORS.some((code) => error.includes(code));
  const dead = attempts >= (transient ? MAX_ATTEMPTS_TRANSIENT : MAX_ATTEMPTS);
  const backoffSeconds = Math.min(2 ** attempts * 5, 3600);
  await pool.query(
    `UPDATE treasury_outbox
        SET state = $2,
            last_error = $3,
            next_attempt_at = now() + ($4 || ' seconds')::interval
      WHERE id = $1`,
    [id, dead ? 'dead' : 'failed', error.slice(0, 2000), backoffSeconds],
  );
}

export async function statusOf(
  id: string,
): Promise<{ state: string; txHash: string | null; lastError: string | null } | null> {
  const res = await pool.query<{ state: string; tx_hash: string | null; last_error: string | null }>(
    'SELECT state, tx_hash, last_error FROM treasury_outbox WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  return row ? { state: row.state, txHash: row.tx_hash, lastError: row.last_error } : null;
}

export async function countDead(): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM treasury_outbox WHERE state = 'dead'`,
  );
  return Number(res.rows[0]?.count ?? 0);
}

// Ledger de patrocínios — uma linha por transação que o sponsor pagou.
//
// Antes não existia registro nenhum: o gasto vivia num Map e sumia no restart.
// Agora cada relay deixa rastro do que foi reservado, do que foi cobrado de
// fato e de como terminou.
import type { PoolClient } from 'pg';
import { pool } from '../pool.js';
import { DAY_SQL } from './quota.js';

export interface CreateReservation {
  appId: string;
  accountId?: string | null;
  smartAccount?: string;
  mode: 'invoke' | 'feebump';
  isDeploy: boolean;
  targets: string[];
  reservedStroops: bigint;
  channelId?: string | null;
  idempotencyKey?: string | null;
  reserveSeconds: number;
}

export interface SponsorshipRow {
  id: string;
  dayUtc: string;
}

export async function createReserved(
  client: PoolClient,
  input: CreateReservation,
): Promise<SponsorshipRow> {
  const res = await client.query<{ id: string; day_utc: string }>(
    `INSERT INTO sponsorships
       (app_id, account_id, smart_account, mode, is_deploy, targets, day_utc,
        reserved_stroops, channel_id, idempotency_key, reserved_until)
     VALUES ($1, $2, $3, $4, $5, $6, ${DAY_SQL}, $7, $8, $9,
             now() + ($10 || ' seconds')::interval)
     RETURNING id, day_utc::text AS day_utc`,
    [
      input.appId,
      input.accountId ?? null,
      input.smartAccount ?? null,
      input.mode,
      input.isDeploy,
      input.targets,
      input.reservedStroops.toString(),
      input.channelId ?? null,
      input.idempotencyKey ?? null,
      input.reserveSeconds,
    ],
  );
  const row = res.rows[0]!;
  return { id: row.id, dayUtc: row.day_utc };
}

export async function markSubmitted(id: string, txHash: string): Promise<void> {
  await pool.query(
    `UPDATE sponsorships SET state = 'submitted', tx_hash = $2 WHERE id = $1`,
    [id, txHash],
  );
}

export async function markSettled(
  client: PoolClient,
  id: string,
  args: {
    status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    txHash?: string;
    charged: bigint;
    errorCode?: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE sponsorships
        SET state = $2, tx_status = $3, tx_hash = COALESCE($4, tx_hash),
            charged_stroops = $5, error_code = $6, settled_at = now()
      WHERE id = $1`,
    [
      id,
      args.status === 'SUCCESS' ? 'succeeded' : 'failed',
      args.status,
      args.txHash ?? null,
      args.charged.toString(),
      args.errorCode ?? null,
    ],
  );
}

export async function markFailed(id: string, errorCode: string): Promise<void> {
  await pool.query(
    `UPDATE sponsorships
        SET state = 'failed', error_code = $2, charged_stroops = 0, settled_at = now()
      WHERE id = $1`,
    [id, errorCode],
  );
}

export async function findByIdempotencyKey(
  appId: string,
  key: string,
): Promise<{ id: string; state: string; txHash: string | null } | null> {
  const res = await pool.query<{ id: string; state: string; tx_hash: string | null }>(
    'SELECT id, state, tx_hash FROM sponsorships WHERE app_id = $1 AND idempotency_key = $2',
    [appId, key],
  );
  const row = res.rows[0];
  return row ? { id: row.id, state: row.state, txHash: row.tx_hash } : null;
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  mode: string;
  isDeploy: boolean;
  targets: string[];
  state: string;
  txHash: string | null;
  txStatus: string | null;
  chargedStroops: string | null;
  errorCode: string | null;
}

export async function history(
  smartAccount: string,
  limit = 25,
  offset = 0,
): Promise<HistoryEntry[]> {
  const res = await pool.query(
    `SELECT id, created_at, mode, is_deploy, targets, state, tx_hash, tx_status,
            charged_stroops, error_code
       FROM sponsorships
      WHERE smart_account = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [smartAccount, limit, offset],
  );
  return res.rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    mode: r.mode,
    isDeploy: r.is_deploy,
    targets: r.targets,
    state: r.state,
    txHash: r.tx_hash,
    txStatus: r.tx_status,
    chargedStroops: r.charged_stroops === null ? null : String(r.charged_stroops),
    errorCode: r.error_code,
  }));
}

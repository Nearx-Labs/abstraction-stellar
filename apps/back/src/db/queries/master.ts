// Conta mestre do tenant, o grant que o serviço consome e o ledger de eventos.
import { createHash } from 'node:crypto';
import { pool } from '../pool.js';

export interface MasterGrant {
  id: string;
  masterAccount: string;
  contextRuleId: number | null;
  ed25519PublicKey: Buffer;
  targetContract: string;
  policyAddress: string;
  maxItems: number;
  periodLedgers: number;
  state: 'pending' | 'active' | 'revoked';
  grantTxHash: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapGrant = (r: any): MasterGrant => ({
  id: r.id,
  masterAccount: r.master_account,
  contextRuleId: r.context_rule_id,
  ed25519PublicKey: r.ed25519_public_key,
  targetContract: r.target_contract,
  policyAddress: r.policy_address,
  maxItems: r.max_items,
  periodLedgers: r.period_ledgers,
  state: r.state,
  grantTxHash: r.grant_tx_hash,
});

const GRANT_COLUMNS = `id, master_account, context_rule_id, ed25519_public_key,
                       target_contract, policy_address, max_items, period_ledgers,
                       state, grant_tx_hash`;

export async function setMasterAccount(appId: string, contractId: string): Promise<void> {
  await pool.query('UPDATE apps SET master_account = $2 WHERE id = $1', [appId, contractId]);
}

export async function masterAccountOf(appId: string): Promise<string | null> {
  const res = await pool.query<{ master_account: string | null }>(
    'SELECT master_account FROM apps WHERE id = $1',
    [appId],
  );
  return res.rows[0]?.master_account ?? null;
}

export async function activeGrant(appId: string): Promise<MasterGrant | null> {
  const res = await pool.query(
    `SELECT ${GRANT_COLUMNS} FROM master_grants
      WHERE app_id = $1 AND state IN ('pending', 'active')`,
    [appId],
  );
  const row = res.rows[0];
  return row ? mapGrant(row) : null;
}

export async function createGrant(input: {
  appId: string;
  masterAccount: string;
  contextRuleId: number | null;
  ed25519PublicKey: Buffer;
  targetContract: string;
  policyAddress: string;
  maxItems: number;
  periodLedgers: number;
  grantTxHash: string | null;
}): Promise<MasterGrant> {
  const res = await pool.query(
    `INSERT INTO master_grants
       (app_id, master_account, context_rule_id, ed25519_public_key, target_contract,
        policy_address, max_items, period_ledgers, state, grant_tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             CASE WHEN $3::int IS NULL THEN 'pending'::master_grant_state
                  ELSE 'active'::master_grant_state END,
             $9)
     RETURNING ${GRANT_COLUMNS}`,
    [
      input.appId,
      input.masterAccount,
      input.contextRuleId,
      input.ed25519PublicKey,
      input.targetContract,
      input.policyAddress,
      input.maxItems,
      input.periodLedgers,
      input.grantTxHash,
    ],
  );
  return mapGrant(res.rows[0]);
}

export async function revokeGrant(id: string): Promise<void> {
  await pool.query(
    `UPDATE master_grants SET state = 'revoked', revoked_at = now() WHERE id = $1`,
    [id],
  );
}

// ── Fake ledger ─────────────────────────────────────────────────────────────

/**
 * JSON canônico do evento + o hash que o commita.
 *
 * A ordem das chaves é significativa: `JSON.stringify` preserva a ordem de
 * inserção e o hash é calculado sobre o resultado. Reordenar muda o hash e
 * quebra a conferência de qualquer registro anterior.
 */
export function buildPayload(
  kind: string,
  fields: Record<string, unknown>,
): { payload: string; hash: string } {
  const payload = JSON.stringify({ type: `ledger_${kind}`, ...fields });
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return { payload, hash };
}

export async function recordEntry(input: {
  appId: string;
  uuid: string;
  kind: string;
  owner?: string | null;
  payload: string;
  payloadHash: string;
}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO ledger_entries (app_id, uuid, kind, owner, payload, payload_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [input.appId, input.uuid, input.kind, input.owner ?? null, input.payload, input.payloadHash],
  );
  return res.rows[0]!.id;
}

export async function confirmEntry(id: string, txHash: string): Promise<void> {
  await pool.query(
    `UPDATE ledger_entries
        SET state = 'confirmed', tx_hash = $2, confirmed_at = now()
      WHERE id = $1`,
    [id, txHash],
  );
}

export async function failEntry(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE ledger_entries SET state = 'failed', error = $2 WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
}

export async function entriesFor(
  appId: string,
  limit = 25,
  offset = 0,
): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query(
    `SELECT id, uuid, kind, owner, payload, payload_hash, state, tx_hash, created_at
       FROM ledger_entries
      WHERE app_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [appId, limit, offset],
  );
  return res.rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    kind: r.kind,
    owner: r.owner,
    payload: r.payload,
    payloadHash: r.payload_hash,
    state: r.state,
    txHash: r.tx_hash,
    createdAt: r.created_at.toISOString(),
  }));
}

/** UUIDs deste app que já foram mintados — evita gastar cota com repetido. */
export async function existingUuids(appId: string, uuids: string[]): Promise<Set<string>> {
  const res = await pool.query<{ uuid: string }>(
    `SELECT uuid FROM ledger_entries
      WHERE app_id = $1 AND kind = 'mint' AND uuid = ANY($2::text[])`,
    [appId, uuids],
  );
  return new Set(res.rows.map((r) => r.uuid));
}

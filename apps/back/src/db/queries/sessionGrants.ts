// Metadados das session keys.
//
// O on-chain sozinho não serve para montar a tela: ele não diz *o que* uma
// context rule é (session key? email signer?), o probe do kit para no rule id
// 8, e sessão revogada some sem histórico. Mas o DB também não é fonte de
// verdade — o worker sessionSync reconcilia contra get_context_rule.
import { pool } from '../pool.js';

export type SessionState = 'pending' | 'active' | 'expired' | 'revoked' | 'failed';

export interface SessionGrant {
  id: string;
  accountId: string;
  smartAccount: string;
  contextRuleId: number | null;
  name: string;
  targetContract: string;
  ed25519PublicKey: Buffer;
  policyAddress: string;
  spendingLimitStroops: bigint;
  periodLedgers: number;
  /** null = grant sem prazo; quem encerra é a revogação. */
  validUntilLedger: bigint | null;
  validUntilEst: Date | null;
  state: SessionState;
  grantTxHash: string | null;
  createdAt: Date;
}

const COLUMNS = `id, account_id, smart_account, context_rule_id, name, target_contract,
                 ed25519_public_key, policy_address, spending_limit_stroops, period_ledgers,
                 valid_until_ledger, valid_until_est, state, grant_tx_hash, created_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const map = (r: any): SessionGrant => ({
  id: r.id,
  accountId: r.account_id,
  smartAccount: r.smart_account,
  contextRuleId: r.context_rule_id,
  name: r.name,
  targetContract: r.target_contract,
  ed25519PublicKey: r.ed25519_public_key,
  policyAddress: r.policy_address,
  spendingLimitStroops: BigInt(r.spending_limit_stroops),
  periodLedgers: r.period_ledgers,
  validUntilLedger: r.valid_until_ledger === null ? null : BigInt(r.valid_until_ledger),
  validUntilEst: r.valid_until_est,
  state: r.state,
  grantTxHash: r.grant_tx_hash,
  createdAt: r.created_at,
});

export async function create(input: {
  appId: string;
  accountId: string;
  smartAccount: string;
  contextRuleId: number | null;
  name: string;
  targetContract: string;
  ed25519PublicKey: Buffer;
  policyAddress: string;
  spendingLimitStroops: bigint;
  periodLedgers: number;
  /** null = grant sem prazo; quem encerra é a revogação. */
  validUntilLedger: bigint | null;
  validUntilEst: Date | null;
  grantTxHash: string | null;
}): Promise<SessionGrant> {
  const res = await pool.query(
    `INSERT INTO session_grants
       (app_id, account_id, smart_account, context_rule_id, name, target_contract,
        ed25519_public_key, policy_address, spending_limit_stroops, period_ledgers,
        valid_until_ledger, valid_until_est, state, grant_tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $4::int IS NULL THEN 'pending'::session_key_state
                  ELSE 'active'::session_key_state END,
             $13)
     RETURNING ${COLUMNS}`,
    [
      input.appId,
      input.accountId,
      input.smartAccount,
      input.contextRuleId,
      input.name,
      input.targetContract,
      input.ed25519PublicKey,
      input.policyAddress,
      input.spendingLimitStroops.toString(),
      input.periodLedgers,
      input.validUntilLedger === null ? null : input.validUntilLedger.toString(),
      input.validUntilEst,
      input.grantTxHash,
    ],
  );
  return map(res.rows[0]);
}

export async function listFor(accountId: string): Promise<SessionGrant[]> {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM session_grants
      WHERE account_id = $1 AND state <> 'failed'
      ORDER BY created_at DESC`,
    [accountId],
  );
  return res.rows.map(map);
}

export async function byRuleId(
  accountId: string,
  ruleId: number,
): Promise<SessionGrant | null> {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM session_grants WHERE account_id = $1 AND context_rule_id = $2`,
    [accountId, ruleId],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

export async function markRevoked(id: string, txHash?: string): Promise<void> {
  await pool.query(
    `UPDATE session_grants
        SET state = 'revoked', revoked_at = now(), revoke_tx_hash = COALESCE($2, revoke_tx_hash)
      WHERE id = $1`,
    [id, txHash ?? null],
  );
}

export async function setState(id: string, state: SessionState): Promise<void> {
  await pool.query(
    'UPDATE session_grants SET state = $2, last_synced_at = now() WHERE id = $1',
    [id, state],
  );
}

export async function touchSynced(id: string): Promise<void> {
  await pool.query('UPDATE session_grants SET last_synced_at = now() WHERE id = $1', [id]);
}

/** Sessões que o worker precisa reconciliar. */
export async function needingSync(limit = 25): Promise<SessionGrant[]> {
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM session_grants
      WHERE state IN ('pending', 'active')
        AND (last_synced_at IS NULL OR last_synced_at < now() - interval '2 minutes')
      ORDER BY last_synced_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  return res.rows.map(map);
}

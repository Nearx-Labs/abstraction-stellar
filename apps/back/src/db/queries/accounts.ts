// Registry de smart accounts.
//
// Não existia nada disso: o vínculo "usuário ↔ conta" vivia só no IndexedDB do
// browser. Sem registry, nenhum sistema consumidor consegue perguntar "qual é a
// conta do usuário X" — é o que `external_id` resolve.
import { pool } from '../pool.js';

export interface SmartAccountRow {
  id: string;
  appId: string;
  contractId: string;
  externalId: string | null;
  label: string | null;
  status: 'pending' | 'deployed' | 'failed';
  deployTxHash: string | null;
  allowanceSetAt: Date | null;
  allowanceMaxPerTx: bigint | null;
  allowanceMaxPerDay: bigint | null;
  createdAt: Date;
}

type Row = {
  id: string;
  app_id: string;
  contract_id: string;
  external_id: string | null;
  label: string | null;
  status: SmartAccountRow['status'];
  deploy_tx_hash: string | null;
  allowance_set_at: Date | null;
  allowance_max_per_tx: bigint | null;
  allowance_max_per_day: bigint | null;
  created_at: Date;
};

const map = (r: Row): SmartAccountRow => ({
  id: r.id,
  appId: r.app_id,
  contractId: r.contract_id,
  externalId: r.external_id,
  label: r.label,
  status: r.status,
  deployTxHash: r.deploy_tx_hash,
  allowanceSetAt: r.allowance_set_at,
  allowanceMaxPerTx: r.allowance_max_per_tx === null ? null : BigInt(r.allowance_max_per_tx),
  allowanceMaxPerDay: r.allowance_max_per_day === null ? null : BigInt(r.allowance_max_per_day),
  createdAt: r.created_at,
});

const COLUMNS = `id, app_id, contract_id, external_id, label, status, deploy_tx_hash,
                 allowance_set_at, allowance_max_per_tx, allowance_max_per_day, created_at`;

export async function upsert(input: {
  appId: string;
  contractId: string;
  externalId?: string | null;
  label?: string | null;
  status?: SmartAccountRow['status'];
  deployTxHash?: string | null;
}): Promise<SmartAccountRow> {
  const res = await pool.query<Row>(
    `INSERT INTO smart_accounts (app_id, contract_id, external_id, label, status, deploy_tx_hash)
     VALUES ($1, $2, $3, $4, COALESCE($5::account_status, 'pending'), $6)
     ON CONFLICT (app_id, contract_id) DO UPDATE
        SET external_id    = COALESCE(EXCLUDED.external_id, smart_accounts.external_id),
            label          = COALESCE(EXCLUDED.label, smart_accounts.label),
            status         = COALESCE(EXCLUDED.status, smart_accounts.status),
            deploy_tx_hash = COALESCE(EXCLUDED.deploy_tx_hash, smart_accounts.deploy_tx_hash),
            last_seen_at   = now()
     RETURNING ${COLUMNS}`,
    [
      input.appId,
      input.contractId,
      input.externalId ?? null,
      input.label ?? null,
      input.status ?? null,
      input.deployTxHash ?? null,
    ],
  );
  return map(res.rows[0]!);
}

export async function byContractId(
  appId: string,
  contractId: string,
): Promise<SmartAccountRow | null> {
  const res = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM smart_accounts WHERE app_id = $1 AND contract_id = $2`,
    [appId, contractId],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

export async function byExternalId(
  appId: string,
  externalId: string,
): Promise<SmartAccountRow | null> {
  const res = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM smart_accounts WHERE app_id = $1 AND external_id = $2`,
    [appId, externalId],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

export async function markDeployed(
  appId: string,
  contractId: string,
  txHash: string,
): Promise<void> {
  await pool.query(
    `UPDATE smart_accounts
        SET status = 'deployed', deploy_tx_hash = COALESCE(deploy_tx_hash, $3), last_seen_at = now()
      WHERE app_id = $1 AND contract_id = $2`,
    [appId, contractId, txHash],
  );
}

export async function recordAllowance(
  appId: string,
  contractId: string,
  maxPerTx: bigint,
  maxPerDay: bigint,
  expiresAt: Date | null,
): Promise<void> {
  await pool.query(
    `UPDATE smart_accounts
        SET allowance_set_at = now(), allowance_max_per_tx = $3,
            allowance_max_per_day = $4, allowance_expires_at = $5
      WHERE app_id = $1 AND contract_id = $2`,
    [appId, contractId, maxPerTx.toString(), maxPerDay.toString(), expiresAt],
  );
}

// ── Credenciais WebAuthn ────────────────────────────────────────────────────

export async function addCredential(input: {
  accountId: string;
  credentialId: string;
  publicKeyRaw: Buffer;
  label?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO account_credentials (account_id, credential_id, public_key_raw, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (credential_id) DO NOTHING`,
    [input.accountId, input.credentialId, input.publicKeyRaw, input.label ?? null],
  );
}

export interface CredentialRow {
  id: string;
  accountId: string;
  credentialId: string;
  publicKeyRaw: Buffer;
  signCount: number;
}

export async function credentialsFor(accountId: string): Promise<CredentialRow[]> {
  const res = await pool.query(
    `SELECT id, account_id, credential_id, public_key_raw, sign_count
       FROM account_credentials
      WHERE account_id = $1 AND revoked_at IS NULL`,
    [accountId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    credentialId: r.credential_id,
    publicKeyRaw: r.public_key_raw,
    signCount: Number(r.sign_count),
  }));
}

export async function credentialById(credentialId: string): Promise<
  (CredentialRow & { contractId: string; appId: string }) | null
> {
  const res = await pool.query(
    `SELECT c.id, c.account_id, c.credential_id, c.public_key_raw, c.sign_count,
            a.contract_id, a.app_id
       FROM account_credentials c
       JOIN smart_accounts a ON a.id = c.account_id
      WHERE c.credential_id = $1 AND c.revoked_at IS NULL`,
    [credentialId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    accountId: r.account_id,
    credentialId: r.credential_id,
    publicKeyRaw: r.public_key_raw,
    signCount: Number(r.sign_count),
    contractId: r.contract_id,
    appId: r.app_id,
  };
}

export async function bumpSignCount(credentialId: string, counter: number): Promise<void> {
  await pool.query(
    'UPDATE account_credentials SET sign_count = $2 WHERE credential_id = $1',
    [credentialId, counter],
  );
}

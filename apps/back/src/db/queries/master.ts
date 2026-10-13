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

/**
 * O grant ativo de um app para um contrato-alvo.
 *
 * O alvo é obrigatório desde 0004_anchor: um app tem um grant por contrato
 * (inventário no demo-ledger, âncora no anchor-ledger), e responder "o grant do
 * app" sem dizer qual devolveria um dos dois ao acaso.
 */
export async function activeGrant(
  appId: string,
  targetContract: string,
): Promise<MasterGrant | null> {
  const res = await pool.query(
    `SELECT ${GRANT_COLUMNS} FROM master_grants
      WHERE app_id = $1 AND target_contract = $2 AND state IN ('pending', 'active')`,
    [appId, targetContract],
  );
  const row = res.rows[0];
  return row ? mapGrant(row) : null;
}

/** Todos os grants vivos do app, para a tela de estado mostrar os dois. */
export async function activeGrants(appId: string): Promise<MasterGrant[]> {
  const res = await pool.query(
    `SELECT ${GRANT_COLUMNS} FROM master_grants
      WHERE app_id = $1 AND state IN ('pending', 'active')
      ORDER BY created_at ASC`,
    [appId],
  );
  return res.rows.map(mapGrant);
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

/**
 * Igual ao `buildPayload`, mas com o digest **completo**.
 *
 * O hash de mint/transfer vive só no Postgres, e 128 bits bastam ali. O de
 * âncora vai para o `payload_hash: BytesN<32>` do anchor-ledger — 32 bytes
 * exatos. Truncar aqui produziria um erro de conversão no momento da
 * submissão, longe da causa.
 */
export function buildAnchorPayload(
  kind: string,
  fields: Record<string, unknown>,
): { payload: string; hash: string } {
  const payload = JSON.stringify({ type: `ledger_${kind}`, ...fields });
  const hash = createHash('sha256').update(payload).digest('hex');
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

/**
 * As entradas de âncora, com o payload completo.
 *
 * `reference` casa contra `uuid` porque é lá que a chave de negócio mora nas
 * linhas de âncora — ver o comentário em 0004_anchor.sql.
 */
export async function recordsFor(
  appId: string,
  options: { limit?: number; offset?: number; kind?: string; reference?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query(
    `SELECT id, uuid, kind, payload, payload_hash, state, tx_hash, error, created_at
       FROM ledger_entries
      WHERE app_id = $1
        AND kind = 'record'
        AND ($4::text IS NULL OR payload->>'kind' = $4)
        AND ($5::text IS NULL OR uuid = $5)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [
      appId,
      options.limit ?? 25,
      options.offset ?? 0,
      options.kind ?? null,
      options.reference ?? null,
    ],
  );
  return res.rows.map((r) => ({
    id: r.id,
    reference: r.uuid,
    payload: r.payload,
    payloadHash: r.payload_hash,
    state: r.state,
    txHash: r.tx_hash,
    error: r.error,
    createdAt: r.created_at.toISOString(),
  }));
}

export interface MintEntry {
  id: string;
  uuid: string;
  state: 'pending' | 'confirmed' | 'failed';
  txHash: string | null;
  createdAt: Date;
}

/**
 * As linhas de mint que já existem para estes UUIDs, com o estado.
 *
 * Antes era um `Set` de UUIDs sem olhar o estado: um mint que falhou uma vez
 * (cota, rede, timeout) deixava a linha `failed` e todo retry com o mesmo UUID
 * — que no MintVRS é o `transaction.id`, fixo por compra — tomava 409
 * UUID_TAKEN para sempre.
 */
export async function mintEntries(appId: string, uuids: string[]): Promise<MintEntry[]> {
  const res = await pool.query<{
    id: string;
    uuid: string;
    state: MintEntry['state'];
    tx_hash: string | null;
    created_at: Date;
  }>(
    `SELECT id, uuid, state, tx_hash, created_at FROM ledger_entries
      WHERE app_id = $1 AND kind = 'mint' AND uuid = ANY($2::text[])`,
    [appId, uuids],
  );
  return res.rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    state: r.state,
    txHash: r.tx_hash,
    createdAt: r.created_at,
  }));
}

/**
 * Reaproveita a linha de um mint que não chegou à chain. O índice único
 * `(app_id, uuid) WHERE kind='mint'` impede uma segunda linha, então o retry
 * volta a mesma para `pending` com o payload novo.
 */
export async function retryMintEntry(
  id: string,
  owner: string,
  payload: string,
  payloadHash: string,
): Promise<void> {
  await pool.query(
    `UPDATE ledger_entries
        SET state = 'pending', error = NULL, tx_hash = NULL, owner = $2,
            payload = $3::jsonb, payload_hash = $4, created_at = now()
      WHERE id = $1 AND state <> 'confirmed'`,
    [id, owner, payload, payloadHash],
  );
}

/** Confirma sem hash conhecido (o item está on-chain, mas a tx se perdeu). */
export async function confirmEntryWithoutHash(id: string, note: string): Promise<void> {
  await pool.query(
    `UPDATE ledger_entries
        SET state = 'confirmed', error = $2, confirmed_at = now()
      WHERE id = $1`,
    [id, note.slice(0, 1000)],
  );
}

/** Hash da transação de mint de um UUID, de qualquer app — leitura pública. */
export async function mintTxHashOf(uuid: string): Promise<string | null> {
  const res = await pool.query<{ tx_hash: string | null }>(
    `SELECT tx_hash FROM ledger_entries
      WHERE kind = 'mint' AND uuid = $1 AND state = 'confirmed'
      ORDER BY confirmed_at DESC NULLS LAST
      LIMIT 1`,
    [uuid],
  );
  return res.rows[0]?.tx_hash ?? null;
}

/**
 * Lock por app, numa conexão dedicada, para o provisionamento. Duas chamadas
 * simultâneas deployavam duas contas e a segunda sobrescrevia a primeira.
 * `null` quando outra chamada já segura o lock.
 */
export async function tryProvisionLock(appId: string): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  const key = `provision:${appId}`;
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [key],
    );
    if (!res.rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    } finally {
      client.release();
    }
  };
}

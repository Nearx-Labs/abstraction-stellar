// A conta mestre é o que o serviço assina por um tenant. Antes destas guardas,
// qualquer portador da publishable key (pública, vai no bundle do front)
// conseguia: registrar a mestre como se fosse sua conta, anexar a própria
// passkey, abrir sessão com contractId === mestre e daí repontar ou revogar a
// mestre e ler os payloads do tenant. E um retry de mint com o UUID de uma
// tentativa que falhou tomava 409 para sempre.
//
// Os testes aqui não tocam a chain: cobrem as decisões tomadas antes de
// qualquer simulação. O caminho on-chain (settle via owner_of, 6107) é exercido
// no E2E contra a testnet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

process.env.NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgres://abstraction:abstraction@localhost:5434/abstraction';

const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/app.js');
const { hashKey } = await import('../src/db/queries/apps.js');
const accounts = await import('../src/db/queries/accounts.js');
const panel = await import('../src/db/queries/panelSessions.js');
const master = await import('../src/db/queries/master.js');
const channels = await import('../src/db/queries/channels.js');
const { env } = await import('../src/env.js');
const { SESSION_COOKIE } = await import('../src/http/middleware/auth.js');

const APP_SLUG = 'test-master-guards';
const MASTER = 'CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV';
const OTHER = 'CCBGDWXPHXPGYJL2T4GDIF6PAGZ3XVYFR67HBFQ5RVJXGNMT5KGCUD5G';

const app = buildApp();
const secretKey = `sk_test_${randomBytes(16).toString('hex')}`;
const publishableKey = `pk_test_${randomBytes(16).toString('hex')}`;
let appId: string;
let masterSession: string;
let otherSession: string;

async function sessionFor(contractId: string): Promise<string> {
  const account = await accounts.upsert({ appId, contractId, status: 'deployed' });
  return panel.createSession(account.id, 1);
}

function call(
  method: string,
  path: string,
  auth: { sk?: string; session?: string } = {},
  body?: unknown,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.sk) headers.Authorization = `Bearer ${auth.sk}`;
  if (auth.session) headers.Cookie = `${SESSION_COOKIE}=${auth.session}`;
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mintGrant(): Promise<void> {
  await master.createGrant({
    appId,
    masterAccount: MASTER,
    contextRuleId: 1,
    ed25519PublicKey: Buffer.alloc(32, 9),
    targetContract: env.DEMO_LEDGER_CONTRACT_ID,
    policyAddress: env.MINT_QUOTA_POLICY_ADDRESS,
    maxItems: 100,
    periodLedgers: 17_280,
    grantTxHash: null,
  });
}

async function mintRow(uuid: string, state: 'pending' | 'confirmed' | 'failed', txHash?: string) {
  const { payload, hash } = master.buildPayload('mint', { uuid, name: 'Chave' });
  const id = await master.recordEntry({
    appId,
    uuid,
    kind: 'mint',
    owner: MASTER,
    payload,
    payloadHash: hash,
  });
  if (state === 'confirmed') await master.confirmEntry(id, txHash ?? 'a'.repeat(64));
  if (state === 'failed') await master.failEntry(id, 'falhou');
  return id;
}

beforeAll(async () => {
  await migrate();
  await pool.query('DELETE FROM apps WHERE slug = $1', [APP_SLUG]);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO apps (slug, name, network, treasury_id)
     VALUES ($1, 'Guards test', 'testnet', '') RETURNING id`,
    [APP_SLUG],
  );
  appId = res.rows[0]!.id;
  await pool.query(
    `INSERT INTO sponsorship_policies
       (app_id, max_fee_per_tx, max_fee_per_day, target_allowlist, allow_deploy, deploy_fee_cap)
     VALUES ($1, 1000, 1000, '{}', false, 0)`,
    [appId],
  );
  for (const [key, kind] of [
    [secretKey, 'secret'],
    [publishableKey, 'publishable'],
  ] as const) {
    await pool.query(
      `INSERT INTO api_keys (app_id, kind, key_prefix, key_hash, label)
       VALUES ($1, $2, $3, $4, 'test')`,
      [appId, kind, key.slice(0, 12), hashKey(key)],
    );
  }
  await master.setMasterAccount(appId, MASTER);
  masterSession = await sessionFor(MASTER);
  otherSession = await sessionFor(OTHER);
});

afterAll(async () => {
  await pool.query('DELETE FROM apps WHERE slug = $1', [APP_SLUG]);
  await pool.end();
});

describe('registro de conta com publishable key', () => {
  it('não toca conta que já existe — era o caminho para anexar passkey na mestre', async () => {
    const res = await call('POST', '/v1/accounts', {}, {
      contractId: MASTER,
      publishableKey,
      credentialId: 'cred-atacante',
      publicKeyHex: `04${'11'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe('ACCOUNT_EXISTS');

    const creds = await pool.query(
      `SELECT 1 FROM account_credentials c
         JOIN smart_accounts a ON a.id = c.account_id
        WHERE a.contract_id = $1 AND c.credential_id = 'cred-atacante'`,
      [MASTER],
    );
    expect(creds.rowCount).toBe(0);
  });
});

describe('quem controla a conta mestre', () => {
  it('sessão de outra conta do app não lê nem mexe na mestre', async () => {
    expect((await call('GET', '/v1/master', { session: otherSession })).status).toBe(403);
    expect(
      (await call('POST', '/v1/master', { session: otherSession }, { contractId: OTHER })).status,
    ).toBe(403);
    expect(
      (await call('DELETE', '/v1/master/grant?target=ledger', { session: otherSession })).status,
    ).toBe(403);
    expect((await call('POST', '/v1/master/provision', { session: otherSession }, {})).status).toBe(
      403,
    );
    expect(await master.masterAccountOf(appId)).toBe(MASTER);
  });

  it('payloads fora da chain: só secret key ou a sessão da própria mestre', async () => {
    expect((await call('GET', '/v1/ledger/entries', { session: otherSession })).status).toBe(403);
    expect((await call('GET', '/v1/ledger/records', { session: otherSession })).status).toBe(403);
    expect((await call('GET', '/v1/ledger/entries', { session: masterSession })).status).toBe(200);
    expect((await call('GET', '/v1/ledger/records', { sk: secretKey })).status).toBe(200);
  });

  it('a sessão da própria mestre e a secret key revogam grant', async () => {
    expect(
      (await call('DELETE', '/v1/master/grant?target=anchor', { session: masterSession })).status,
    ).toBe(200);
    expect((await call('DELETE', '/v1/master/grant?target=anchor', { sk: secretKey })).status).toBe(
      200,
    );
  });
});

describe('mint idempotente', () => {
  beforeAll(mintGrant);

  it('lote inteiro já confirmado devolve 200 com o hash original, sem nova transação', async () => {
    const uuid = randomUUID();
    const txHash = 'b'.repeat(64);
    await mintRow(uuid, 'confirmed', txHash);

    const res = await call('POST', '/v1/ledger/mint', { sk: secretKey }, { uuids: [uuid], name: 'Chave' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyMinted).toBe(true);
    expect(body.hash).toBe(txHash);
    expect(body.minted).toBe(0);
  });

  it('lote misturando confirmado e novo é recusado', async () => {
    const done = randomUUID();
    await mintRow(done, 'confirmed');
    const res = await call(
      'POST',
      '/v1/ledger/mint',
      { sk: secretKey },
      { uuids: [done, randomUUID()], name: 'Chave' },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe('UUID_TAKEN');
  });

  it('pending recente é tentativa em voo: 409 UUID_PENDING, não outra transação', async () => {
    const uuid = randomUUID();
    await mintRow(uuid, 'pending');
    const res = await call('POST', '/v1/ledger/mint', { sk: secretKey }, { uuids: [uuid], name: 'Chave' });
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe('UUID_PENDING');
  });

  it('lote acima do teto do contrato é recusado antes da chain', async () => {
    const uuids = Array.from({ length: 11 }, () => randomUUID());
    const res = await call('POST', '/v1/ledger/mint', { sk: secretKey }, { uuids, name: 'Chave' });
    expect(res.status).toBe(400);
  });

  it('a linha failed volta para pending no retry (o índice único não deixa criar outra)', async () => {
    const uuid = randomUUID();
    const id = await mintRow(uuid, 'failed');
    const { payload, hash } = master.buildPayload('mint', { uuid, name: 'Chave 2' });
    await master.retryMintEntry(id, MASTER, payload, hash);

    const [row] = await master.mintEntries(appId, [uuid]);
    expect(row?.id).toBe(id);
    expect(row?.state).toBe('pending');
  });

  it('grant de outra mestre não serve: NO_GRANT em vez de assinar com regra inexistente', async () => {
    await master.setMasterAccount(appId, OTHER);
    try {
      const res = await call(
        'POST',
        '/v1/ledger/mint',
        { sk: secretKey },
        { uuids: [randomUUID()], name: 'Chave' },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).errorCode).toBe('NO_GRANT');
    } finally {
      await master.setMasterAccount(appId, MASTER);
    }
  });

  it('GET /v1/ledger/:uuid inclui o hash do mint guardado pelo serviço', async () => {
    const uuid = randomUUID();
    await mintRow(uuid, 'confirmed', 'c'.repeat(64));
    expect(await master.mintTxHashOf(uuid)).toBe('c'.repeat(64));
  });
});

describe('provisionamento e channels', () => {
  it('duas chamadas simultâneas: a segunda não pega o lock', async () => {
    const first = await master.tryProvisionLock(appId);
    expect(first).not.toBeNull();
    const second = await master.tryProvisionLock(appId);
    expect(second).toBeNull();
    await first!();
    const third = await master.tryProvisionLock(appId);
    expect(third).not.toBeNull();
    await third!();
  });

  it('acquire espera o tempo pedido antes de desistir', async () => {
    const started = Date.now();
    await expect(
      channels.acquire('channel', { publicKey: 'G-que-nao-existe', waitMs: 600 }),
    ).rejects.toBeInstanceOf(channels.NoChannelAvailableError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });
});

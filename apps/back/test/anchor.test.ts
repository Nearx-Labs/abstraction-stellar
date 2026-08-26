// A âncora é o caminho que o MintVRS usa para tudo que NÃO é item — compra de
// crédito, reembolso, split. Três propriedades sustentam a integração, e as
// três já quebraram em versões anteriores deste desenho:
//
//   1. o hash que sobe é o digest COMPLETO (o truncado de 16 bytes é recusado
//      pelo `BytesN<32>` do contrato, e o erro sai longe da causa);
//   2. inventário e âncora têm grants independentes — reconceder um não pode
//      derrubar o outro;
//   3. âncora repete referência de propósito, então o índice único de mint não
//      pode alcançá-la.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

process.env.NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgres://abstraction:abstraction@localhost:5434/abstraction';

const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const master = await import('../src/db/queries/master.js');

const APP_SLUG = 'test-anchor';
const LEDGER = 'CCBGDWXPHXPGYJL2T4GDIF6PAGZ3XVYFR67HBFQ5RVJXGNMT5KGCUD5G';
const ANCHOR = 'CAJLZT55SAI5U23QK3EBGBKHIJSOASKACLVRTTVAK6WHVOUYYGLO3YTA';
const POLICY = 'CCKCKDXEWD3LHSZT3OLTJTRFNMXPQPONKUPQPQJ2CAXFVNACJDFAYWVJ';
const MASTER_ACCOUNT = 'CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV';

let appId: string;

beforeAll(async () => {
  await migrate();
  await pool.query('DELETE FROM apps WHERE slug = $1', [APP_SLUG]);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO apps (slug, name, network, treasury_id)
     VALUES ($1, 'Anchor test', 'testnet', $2) RETURNING id`,
    [APP_SLUG, MASTER_ACCOUNT],
  );
  appId = res.rows[0]!.id;
  await pool.query('UPDATE apps SET master_account = $2 WHERE id = $1', [appId, MASTER_ACCOUNT]);
});

afterAll(async () => {
  await pool.query('DELETE FROM apps WHERE slug = $1', [APP_SLUG]);
  await pool.end();
});

function grant(targetContract: string, maxItems: number) {
  return master.createGrant({
    appId,
    masterAccount: MASTER_ACCOUNT,
    contextRuleId: targetContract === ANCHOR ? 2 : 1,
    ed25519PublicKey: Buffer.alloc(32, 7),
    targetContract,
    policyAddress: POLICY,
    maxItems,
    periodLedgers: 17_280,
    grantTxHash: null,
  });
}

describe('payload da âncora', () => {
  it('usa o digest completo, que é o que cabe em BytesN<32>', () => {
    const { payload, hash } = master.buildAnchorPayload('record', { kind: 'refund', amount: '1' });

    expect(hash).toHaveLength(64);
    expect(Buffer.from(hash, 'hex')).toHaveLength(32);
    expect(hash).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  it('difere do hash de mint, que é truncado de propósito', () => {
    const fields = { uuid: 'a', name: 'b' };
    expect(master.buildPayload('mint', fields).hash).toHaveLength(32);
    expect(master.buildAnchorPayload('mint', fields).hash).toHaveLength(64);
  });

  it('commita o payload: um campo a mais muda o hash', () => {
    const a = master.buildAnchorPayload('record', { kind: 'refund', amount: '100' });
    const b = master.buildAnchorPayload('record', { kind: 'refund', amount: '101' });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('grants por alvo', () => {
  it('inventário e âncora coexistem, cada um com seu teto', async () => {
    await grant(LEDGER, 10_000);
    await grant(ANCHOR, 500);

    const ledgerGrant = await master.activeGrant(appId, LEDGER);
    const anchorGrant = await master.activeGrant(appId, ANCHOR);

    expect(ledgerGrant?.maxItems).toBe(10_000);
    expect(anchorGrant?.maxItems).toBe(500);
    expect(await master.activeGrants(appId)).toHaveLength(2);
  });

  it('reconceder a âncora não derruba o inventário', async () => {
    const stale = await master.activeGrant(appId, ANCHOR);
    await master.revokeGrant(stale!.id);
    await grant(ANCHOR, 900);

    expect((await master.activeGrant(appId, ANCHOR))?.maxItems).toBe(900);
    // o que quebrava antes: um único grant ativo por app derrubava este aqui
    expect((await master.activeGrant(appId, LEDGER))?.maxItems).toBe(10_000);
  });

  it('dois grants ativos no MESMO alvo continuam proibidos', async () => {
    await expect(grant(ANCHOR, 1)).rejects.toThrow(/master_grants_active_uq/);
  });

  it('alvo sem grant é null, não o grant do outro alvo', async () => {
    const other = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    expect(await master.activeGrant(appId, other)).toBeNull();
  });
});

describe('entradas de âncora', () => {
  it('a mesma referência entra duas vezes — dois eventos, não um repetido', async () => {
    const reference = `tx-${randomUUID()}`;

    for (const amount of ['100', '200']) {
      const { payload, hash } = master.buildAnchorPayload('record', {
        tenantId: 'tenant-x',
        kind: 'credit_lock',
        reference,
        amount,
      });
      await master.recordEntry({
        appId,
        uuid: reference,
        kind: 'record',
        owner: null,
        payload,
        payloadHash: hash,
      });
    }

    const found = await master.recordsFor(appId, { reference });
    expect(found).toHaveLength(2);
    // o índice único de mint é parcial e não alcança âncora
    expect(await master.existingUuids(appId, [reference])).toEqual(new Set());
  });

  it('filtra por tipo de evento', async () => {
    const reference = `tx-${randomUUID()}`;
    const { payload, hash } = master.buildAnchorPayload('record', {
      tenantId: 'tenant-x',
      kind: 'refund',
      reference,
      amount: '990',
    });
    await master.recordEntry({
      appId,
      uuid: reference,
      kind: 'record',
      owner: null,
      payload,
      payloadHash: hash,
    });

    const refunds = await master.recordsFor(appId, { kind: 'refund' });
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every((r) => (r.payload as Record<string, unknown>).kind === 'refund')).toBe(
      true,
    );
    expect(await master.recordsFor(appId, { kind: 'nao_existe' })).toHaveLength(0);
  });

  it('âncora não aparece no inventário, e vice-versa', async () => {
    const uuid = randomUUID();
    const { payload, hash } = master.buildPayload('mint', { uuid, name: 'Chave' });
    await master.recordEntry({
      appId,
      uuid,
      kind: 'mint',
      owner: MASTER_ACCOUNT,
      payload,
      payloadHash: hash,
    });

    expect(await master.existingUuids(appId, [uuid])).toEqual(new Set([uuid]));
    expect(await master.recordsFor(appId, { reference: uuid })).toHaveLength(0);
  });
});

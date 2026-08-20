// Conta mestre do tenant: configuração, grant e as operações que o serviço faz
// sozinho dentro do teto concedido.
//
// A separação de poderes é o ponto:
//   · o tenant, com passkey, define a conta mestre e concede o grant;
//   · a API assina mint e transfer, mas só no contrato do ledger e só até o
//     número de itens autorizado;
//   · quem recusa o item N+1 é o contrato, não um rate limit nosso.
import { Hono } from 'hono';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { env } from '../env.js';
import { logger } from '../logger.js';
import * as master from '../db/queries/master.js';
import * as ledger from '../chain/ledger.js';
import { getQuotaData } from '../chain/quota.js';
import { invokeAsMaster, masterSignerIdentity } from '../chain/masterSigner.js';
import { withChannel } from '../db/queries/channels.js';
import { assertCanActOn, requireCaller, requireService } from './middleware/auth.js';

export const masterRoutes = new Hono();

const C_ADDRESS = /^C[A-Z2-7]{55}$/;
/** Espelha MAX_BATCH em contracts/demo-ledger. */
const MAX_BATCH = 100;

function notConfigured(what: string) {
  return { success: false as const, error: `${what} não configurado`, errorCode: 'NOT_CONFIGURED' };
}

/** Estado completo: conta, chave do serviço, grant e cota consumida on-chain. */
masterRoutes.get('/master', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const [masterAccount, grant] = await Promise.all([
    master.masterAccountOf(appId),
    master.activeGrant(appId),
  ]);

  const quota =
    grant?.contextRuleId !== null && grant !== null && masterAccount
      ? await getQuotaData(grant.policyAddress, grant.contextRuleId!, masterAccount)
      : null;

  return c.json({
    success: true,
    masterAccount,
    /** O tenant precisa disto para montar o grant no browser. */
    signer: masterSignerIdentity(appId),
    ledgerContract: env.DEMO_LEDGER_CONTRACT_ID,
    policyContract: env.MINT_QUOTA_POLICY_ADDRESS,
    grant: grant
      ? {
          contextRuleId: grant.contextRuleId,
          maxItems: grant.maxItems,
          periodLedgers: grant.periodLedgers,
          state: grant.state,
          grantTxHash: grant.grantTxHash,
        }
      : null,
    quota: quota
      ? {
          maxItems: quota.maxItems,
          used: quota.used,
          remaining: Math.max(quota.maxItems - quota.used, 0),
          windowResetsAtLedger: quota.windowResetsAt,
        }
      : null,
  });
});

/** Define qual smart account é a mestre deste tenant. */
masterRoutes.post('/master', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const { contractId } = await c.req.json<{ contractId?: string }>();

  if (!contractId || !C_ADDRESS.test(contractId)) {
    return c.json(
      { success: false, error: 'contractId inválido', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  // Sessão de painel só pode nomear a própria conta; secret key pode nomear
  // qualquer conta registrada do app.
  const account = await assertCanActOn(c, contractId);
  if (!account) {
    return c.json(
      { success: false, error: 'conta não registrada neste app', errorCode: 'NOT_FOUND' },
      404,
    );
  }

  await master.setMasterAccount(appId, contractId);
  logger.info({ appId, contractId }, 'conta mestre definida');
  return c.json({ success: true, masterAccount: contractId, signer: masterSignerIdentity(appId) });
});

/**
 * Registra o grant depois que o browser o criou.
 *
 * A criação da regra é assinada com a passkey do tenant — o serviço não pode
 * conceder poder a si mesmo. Aqui só guardamos o metadado.
 */
masterRoutes.post('/master/grant', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const body = await c.req.json<{
    contextRuleId?: number;
    maxItems?: number;
    periodLedgers?: number;
    grantTxHash?: string;
  }>();

  const masterAccount = await master.masterAccountOf(appId);
  if (!masterAccount) return c.json(notConfigured('conta mestre'), 409);

  if (!body.maxItems || body.maxItems <= 0 || !body.periodLedgers || body.periodLedgers <= 0) {
    return c.json(
      { success: false, error: 'maxItems e periodLedgers são obrigatórios', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  const existing = await master.activeGrant(appId);
  if (existing) await master.revokeGrant(existing.id);

  const signer = masterSignerIdentity(appId);
  const grant = await master.createGrant({
    appId,
    masterAccount,
    contextRuleId: body.contextRuleId ?? null,
    ed25519PublicKey: Buffer.from(signer.publicKeyHex, 'hex'),
    targetContract: env.DEMO_LEDGER_CONTRACT_ID,
    policyAddress: env.MINT_QUOTA_POLICY_ADDRESS,
    maxItems: body.maxItems,
    periodLedgers: body.periodLedgers,
    grantTxHash: body.grantTxHash ?? null,
  });

  logger.info({ appId, maxItems: grant.maxItems }, 'grant da conta mestre registrado');
  return c.json({ success: true, id: grant.id, state: grant.state });
});

masterRoutes.delete('/master/grant', requireCaller(), async (c) => {
  const grant = await master.activeGrant(c.get('caller').appId);
  if (grant) await master.revokeGrant(grant.id);
  return c.json({ success: true });
});

// ── Operações do serviço ────────────────────────────────────────────────────

async function requireGrant(appId: string) {
  const [masterAccount, grant] = await Promise.all([
    master.masterAccountOf(appId),
    master.activeGrant(appId),
  ]);
  if (!masterAccount || !grant || grant.contextRuleId === null) return null;
  return { masterAccount, grant };
}

/** Minta um lote em nome do tenant. Server-to-server. */
masterRoutes.post('/ledger/mint', requireService(), async (c) => {
  const { appId } = c.get('caller');
  const body = await c.req.json<{
    uuids?: string[];
    name?: string;
    fields?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }>();

  const context = await requireGrant(appId);
  if (!context) {
    return c.json(
      {
        success: false,
        error: 'o tenant ainda não concedeu permissão de mint a este serviço',
        errorCode: 'NO_GRANT',
      },
      409,
    );
  }

  const uuids = (body.uuids ?? []).map((u) => u.trim()).filter(Boolean);
  if (uuids.length === 0 || uuids.length > MAX_BATCH) {
    return c.json(
      {
        success: false,
        error: `envie de 1 a ${MAX_BATCH} uuids (o limite é de recursos da transação)`,
        errorCode: 'INVALID_PARAMS',
      },
      400,
    );
  }
  if (!body.name) {
    return c.json({ success: false, error: 'name é obrigatório', errorCode: 'INVALID_PARAMS' }, 400);
  }

  // Repetido gastaria cota e ainda assim o contrato recusaria por UuidTaken.
  const already = await master.existingUuids(appId, uuids);
  if (already.size > 0) {
    return c.json(
      {
        success: false,
        error: `uuid já mintado: ${[...already].slice(0, 3).join(', ')}`,
        errorCode: 'UUID_TAKEN',
      },
      409,
    );
  }

  const fields = Object.entries(body.fields ?? {});
  const args = [
    new Address(context.masterAccount).toScVal(),
    xdr.ScVal.scvVec(uuids.map((u) => nativeToScVal(u, { type: 'string' }))),
    nativeToScVal(body.name, { type: 'string' }),
    nativeToScVal('', { type: 'string' }),
    xdr.scvSortedMap(
      fields.map(
        ([key, value]) =>
          new xdr.ScMapEntry({
            key: nativeToScVal(key, { type: 'string' }),
            val: nativeToScVal(String(value), { type: 'string' }),
          }),
      ),
    ),
  ];

  const entryIds = await Promise.all(
    uuids.map((uuid) => {
      const { payload, hash } = master.buildPayload('mint', {
        uuid,
        name: body.name,
        fields: body.fields ?? {},
        ...(body.metadata ?? {}),
      });
      return master.recordEntry({
        appId,
        uuid,
        kind: 'mint',
        owner: context.masterAccount,
        payload,
        payloadHash: hash,
      });
    }),
  );

  try {
    const result = await withChannel('channel', (lease) =>
      invokeAsMaster({
        appId,
        masterAccount: context.masterAccount,
        contractId: env.DEMO_LEDGER_CONTRACT_ID,
        fn: 'mint_batch',
        args,
        contextRuleId: context.grant.contextRuleId!,
        payer: lease.keypair,
      }),
    );

    await Promise.all(entryIds.map((id) => master.confirmEntry(id, result.hash)));
    logger.info({ appId, minted: uuids.length, hash: result.hash }, 'lote mintado');

    return c.json({ success: true, minted: uuids.length, uuids, hash: result.hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all(entryIds.map((id) => master.failEntry(id, message)));

    // 6200 é QuotaExceeded na mint-quota-policy: o tenant não autorizou tanto.
    const quotaHit = message.includes('6200');
    return c.json(
      {
        success: false,
        error: quotaHit ? 'a cota de itens concedida pelo tenant acabou' : message,
        errorCode: quotaHit ? 'QUOTA_EXCEEDED' : 'ONCHAIN_FAILED',
      },
      quotaHit ? 403 : 502,
    );
  }
});

/** Venda do marketplace: passa a posse de um item. Server-to-server. */
masterRoutes.post('/ledger/transfer', requireService(), async (c) => {
  const { appId } = c.get('caller');
  const { uuid, to, metadata } = await c.req.json<{
    uuid?: string;
    to?: string;
    metadata?: Record<string, unknown>;
  }>();

  if (!uuid || !to || !/^[GC][A-Z2-7]{55}$/.test(to)) {
    return c.json(
      { success: false, error: 'uuid e to (G… ou C…) são obrigatórios', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  const context = await requireGrant(appId);
  if (!context) {
    return c.json(
      { success: false, error: 'sem permissão concedida', errorCode: 'NO_GRANT' },
      409,
    );
  }

  const current = await ledger.ownerOf(env.DEMO_LEDGER_CONTRACT_ID, uuid);
  if (current !== context.masterAccount) {
    // Depois da primeira venda quem autoriza é o comprador, não a conta mestre.
    return c.json(
      {
        success: false,
        error: `a conta mestre não é a dona atual (dono: ${current ?? 'desconhecido'})`,
        errorCode: 'NOT_OWNER',
      },
      409,
    );
  }

  const { payload, hash } = master.buildPayload('transfer', {
    uuid,
    from: context.masterAccount,
    to,
    ...(metadata ?? {}),
  });
  const entryId = await master.recordEntry({
    appId,
    uuid,
    kind: 'transfer',
    owner: to,
    payload,
    payloadHash: hash,
  });

  try {
    const result = await withChannel('channel', (lease) =>
      invokeAsMaster({
        appId,
        masterAccount: context.masterAccount,
        contractId: env.DEMO_LEDGER_CONTRACT_ID,
        fn: 'transfer',
        args: [nativeToScVal(uuid, { type: 'string' }), new Address(to).toScVal()],
        contextRuleId: context.grant.contextRuleId!,
        payer: lease.keypair,
      }),
    );

    await master.confirmEntry(entryId, result.hash);
    return c.json({ success: true, uuid, to, hash: result.hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await master.failEntry(entryId, message);
    return c.json({ success: false, error: message, errorCode: 'ONCHAIN_FAILED' }, 502);
  }
});

/** O ledger completo do tenant, com o payload que ficou fora da chain. */
masterRoutes.get('/ledger/entries', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  return c.json({ success: true, items: await master.entriesFor(appId, limit, offset) });
});

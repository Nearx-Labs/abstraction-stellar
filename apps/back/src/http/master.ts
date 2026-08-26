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
import {
  addServiceRule,
  deployManagedAccount,
  findRuleFor,
  ownerSignerFor,
} from '../chain/managedAccount.js';
import { withChannel } from '../db/queries/channels.js';
import { assertCanActOn, requireCaller, requireService } from './middleware/auth.js';

export const masterRoutes = new Hono();

const C_ADDRESS = /^C[A-Z2-7]{55}$/;
/** Espelha MAX_BATCH em contracts/demo-ledger. */
const MAX_BATCH = 100;
/** Ledgers por dia, com fechamento a cada ~5s. */
const DAY_IN_LEDGERS = 17_280;
/** Espelhos de contracts/anchor-ledger. */
const MAX_TENANT_LEN = 64;
const MAX_REFERENCE_LEN = 128;
/** Símbolo Soroban: [a-zA-Z0-9_], até 32 chars. `kind` vira Symbol on-chain. */
const KIND = /^[a-zA-Z0-9_]{1,32}$/;

/**
 * Os dois contratos que a conta mestre pode assinar, e o grant de cada um.
 *
 * O nome curto é o que trafega na API — o painel não precisa conhecer contract
 * id para dizer qual permissão está concedendo, e trocar o contrato de lugar
 * (redeploy) não muda o contrato da API.
 */
const TARGETS = {
  ledger: () => env.DEMO_LEDGER_CONTRACT_ID,
  anchor: () => env.ANCHOR_CONTRACT_ID,
} as const;

type TargetName = keyof typeof TARGETS;

function targetContract(name: string | undefined): string | null {
  const key = (name ?? 'ledger') as TargetName;
  return key in TARGETS ? TARGETS[key]() : null;
}

function notConfigured(what: string) {
  return { success: false as const, error: `${what} não configurado`, errorCode: 'NOT_CONFIGURED' };
}

/**
 * Estado completo: conta, chave do serviço, os grants e a cota de cada um.
 *
 * `grant`/`quota` no singular continuam apontando para o inventário — o painel
 * antigo lê essas chaves, e mudá-las quebraria a tela sem ganho. Os dois alvos
 * vivem em `grants`/`quotas`, indexados pelo nome curto.
 */
masterRoutes.get('/master', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const [masterAccount, grants] = await Promise.all([
    master.masterAccountOf(appId),
    master.activeGrants(appId),
  ]);

  const byTarget = new Map(grants.map((g) => [g.targetContract, g]));

  const described = await Promise.all(
    (Object.keys(TARGETS) as TargetName[]).map(async (name) => {
      const grant = byTarget.get(TARGETS[name]()) ?? null;
      const quota =
        grant && grant.contextRuleId !== null && masterAccount
          ? await getQuotaData(grant.policyAddress, grant.contextRuleId, masterAccount)
          : null;

      return [
        name,
        {
          contract: TARGETS[name](),
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
        },
      ] as const;
    }),
  );

  // `Object.fromEntries` perde a chave literal; o Record<> abaixo devolve o
  // que o TARGETS já garante — todo alvo tem uma entrada.
  const targets = Object.fromEntries(described) as Record<
    TargetName,
    (typeof described)[number][1]
  >;

  return c.json({
    success: true,
    masterAccount,
    /** O tenant precisa disto para montar o grant no browser. */
    signer: masterSignerIdentity(appId),
    ledgerContract: env.DEMO_LEDGER_CONTRACT_ID,
    anchorContract: env.ANCHOR_CONTRACT_ID,
    policyContract: env.MINT_QUOTA_POLICY_ADDRESS,
    grant: targets.ledger.grant,
    quota: targets.ledger.quota,
    targets,
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
    target?: string;
  }>();

  // Omitido = inventário: é o que o painel mandava antes de existir a âncora.
  const contract = targetContract(body.target);
  if (!contract) {
    return c.json(
      { success: false, error: `target inválido: ${body.target}`, errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  const masterAccount = await master.masterAccountOf(appId);
  if (!masterAccount) return c.json(notConfigured('conta mestre'), 409);

  if (!body.maxItems || body.maxItems <= 0 || !body.periodLedgers || body.periodLedgers <= 0) {
    return c.json(
      { success: false, error: 'maxItems e periodLedgers são obrigatórios', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  // Só o grant DESTE alvo é substituído — revogar o outro junto derrubaria o
  // inventário ao reconceder a âncora, e vice-versa.
  const existing = await master.activeGrant(appId, contract);
  if (existing) await master.revokeGrant(existing.id);

  const signer = masterSignerIdentity(appId);
  const grant = await master.createGrant({
    appId,
    masterAccount,
    contextRuleId: body.contextRuleId ?? null,
    ed25519PublicKey: Buffer.from(signer.publicKeyHex, 'hex'),
    targetContract: contract,
    policyAddress: env.MINT_QUOTA_POLICY_ADDRESS,
    maxItems: body.maxItems,
    periodLedgers: body.periodLedgers,
    grantTxHash: body.grantTxHash ?? null,
  });

  logger.info(
    { appId, target: body.target ?? 'ledger', maxItems: grant.maxItems },
    'grant da conta mestre registrado',
  );
  return c.json({ success: true, id: grant.id, state: grant.state });
});

masterRoutes.delete('/master/grant', requireCaller(), async (c) => {
  const contract = targetContract(c.req.query('target'));
  if (!contract) {
    return c.json(
      { success: false, error: 'target inválido', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }
  const grant = await master.activeGrant(c.get('caller').appId, contract);
  if (grant) await master.revokeGrant(grant.id);
  return c.json({ success: true });
});

/**
 * Provisiona a conta mestre do tenant inteira — sem passkey, sem browser.
 *
 * É o caminho do produto: o tenant faz login social no portal e já encontra a
 * conta pronta com as duas permissões concedidas. Ele não registra digital,
 * não guarda seed e não assina nada.
 *
 * O que roda aqui, em três transações patrocinadas:
 *   1. deploy da smart account, com a chave de OWNER na regra Default;
 *   2. regra `CallContract(demo-ledger)` + cota de itens, para a chave do SERVIÇO;
 *   3. regra `CallContract(anchor-ledger)` + cota de eventos, idem.
 *
 * Idempotente: o endereço é derivado do app, então repetir encontra a conta que
 * já existe e só completa o que falta. Útil quando a segunda regra falha e a
 * primeira não.
 *
 * O painel com passkey continua existindo para quem quiser auto-custódia — lá
 * quem assina é o dono. Aqui a custódia é da plataforma, que é o modelo deste
 * produto.
 */
masterRoutes.post('/master/provision', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const body = await c.req
    .json<{ ledgerMaxItems?: number; anchorMaxItems?: number; periodLedgers?: number }>()
    .catch(() => ({}) as Record<string, never>);

  const periodLedgers = body.periodLedgers ?? DAY_IN_LEDGERS * 30;
  const wanted = [
    { target: 'ledger' as const, name: 'mint do serviço', maxItems: body.ledgerMaxItems ?? 10_000 },
    { target: 'anchor' as const, name: 'âncora do serviço', maxItems: body.anchorMaxItems ?? 50_000 },
  ];

  try {
    const result = await withChannel('channel', async (lease) => {
      const { contractId, hash } = await deployManagedAccount({
        appId,
        payer: lease.keypair,
      });
      await master.setMasterAccount(appId, contractId);

      const granted: Array<{ target: string; contextRuleId: number | null; hash: string }> = [];

      for (const { target, name, maxItems } of wanted) {
        const contract = TARGETS[target]();

        // Já concedida numa rodada anterior: não gasta outra transação.
        const existing = await master.activeGrant(appId, contract);
        if (existing?.contextRuleId !== null && existing !== null) continue;
        if (existing) await master.revokeGrant(existing.id);

        const rule = await addServiceRule({
          appId,
          masterAccount: contractId,
          targetContract: contract,
          ruleName: name,
          maxItems,
          periodLedgers,
          payer: lease.keypair,
        });

        const contextRuleId = await findRuleFor(contractId, contract, lease.keypair);

        const signer = masterSignerIdentity(appId);
        await master.createGrant({
          appId,
          masterAccount: contractId,
          contextRuleId,
          ed25519PublicKey: Buffer.from(signer.publicKeyHex, 'hex'),
          targetContract: contract,
          policyAddress: env.MINT_QUOTA_POLICY_ADDRESS,
          maxItems,
          periodLedgers,
          grantTxHash: rule.hash,
        });

        granted.push({ target, contextRuleId, hash: rule.hash });
      }

      return { contractId, deployHash: hash, granted };
    });

    logger.info(
      { appId, masterAccount: result.contractId, granted: result.granted.length },
      'conta mestre provisionada',
    );

    return c.json({
      success: true,
      masterAccount: result.contractId,
      deployHash: result.deployHash,
      owner: ownerSignerFor(appId).publicKey(),
      signer: masterSignerIdentity(appId),
      granted: result.granted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ appId, err: message }, 'provisionamento falhou');
    return c.json({ success: false, error: message, errorCode: 'ONCHAIN_FAILED' }, 502);
  }
});

// ── Operações do serviço ────────────────────────────────────────────────────

async function requireGrant(appId: string, target: TargetName) {
  const [masterAccount, grant] = await Promise.all([
    master.masterAccountOf(appId),
    master.activeGrant(appId, TARGETS[target]()),
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

  const context = await requireGrant(appId, 'ledger');
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

  const context = await requireGrant(appId, 'ledger');
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

// ── Âncora de eventos de negócio ────────────────────────────────────────────

/**
 * Ancora um evento contábil. Server-to-server.
 *
 * Não é um item: não tem dono, não entra no inventário e não gasta a cota de
 * mint. On-chain vai o indispensável (tenant, tipo, referência, valor e o
 * sha256 do payload); o JSON inteiro fica em `ledger_entries`, e é o hash que
 * amarra os dois.
 *
 * Ao contrário do mint, **não deduplica**: dois `credit_lock` da mesma
 * transação são dois eventos, e recusar o segundo apagaria histórico real.
 */
masterRoutes.post('/ledger/record', requireService(), async (c) => {
  const { appId } = c.get('caller');
  const body = await c.req.json<{
    tenantId?: string;
    kind?: string;
    reference?: string;
    payload?: Record<string, unknown> | string;
    amount?: string | number;
  }>();

  const tenantId = (body.tenantId ?? '').trim();
  const kind = (body.kind ?? '').trim();
  const reference = (body.reference ?? '').trim();

  if (!tenantId || tenantId.length > MAX_TENANT_LEN) {
    return c.json(
      {
        success: false,
        error: `tenantId é obrigatório e cabe em ${MAX_TENANT_LEN} chars`,
        errorCode: 'INVALID_PARAMS',
      },
      400,
    );
  }
  if (!KIND.test(kind)) {
    return c.json(
      {
        success: false,
        error: 'kind precisa casar [a-zA-Z0-9_]{1,32} — vira Symbol on-chain',
        errorCode: 'INVALID_PARAMS',
      },
      400,
    );
  }
  if (reference.length > MAX_REFERENCE_LEN) {
    return c.json(
      {
        success: false,
        error: `reference cabe em ${MAX_REFERENCE_LEN} chars`,
        errorCode: 'INVALID_PARAMS',
      },
      400,
    );
  }

  // i128 não aceita fracionário: o consumidor manda na menor unidade. Sem
  // valor, `1` — o mesmo que o ledger antigo carimbava.
  let amount: bigint;
  try {
    amount = BigInt(body.amount ?? 1);
  } catch {
    return c.json(
      {
        success: false,
        error: 'amount precisa ser inteiro na menor unidade (centavos), não fracionário',
        errorCode: 'INVALID_PARAMS',
      },
      400,
    );
  }

  const context = await requireGrant(appId, 'anchor');
  if (!context) {
    return c.json(
      {
        success: false,
        error: 'o tenant ainda não concedeu permissão de âncora a este serviço',
        errorCode: 'NO_GRANT',
      },
      409,
    );
  }

  // O hash é do payload EXATO que fica gravado — é o que o consumidor
  // reconfere depois contra `verify` no contrato.
  const { payload, hash } = master.buildAnchorPayload('record', {
    tenantId,
    kind,
    reference,
    amount: amount.toString(),
    body: typeof body.payload === 'string' ? body.payload : (body.payload ?? {}),
  });

  const entryId = await master.recordEntry({
    appId,
    // Em linha de âncora o `uuid` carrega a referência de negócio — ver
    // 0004_anchor.sql. Vazio viraria NOT NULL violation, então cai no id.
    uuid: reference || entryFallback(hash),
    kind: 'record',
    owner: null,
    payload,
    payloadHash: hash,
  });

  const args = [
    new Address(context.masterAccount).toScVal(),
    nativeToScVal(tenantId, { type: 'string' }),
    nativeToScVal(kind, { type: 'symbol' }),
    nativeToScVal(reference, { type: 'string' }),
    xdr.ScVal.scvBytes(Buffer.from(hash, 'hex')),
    nativeToScVal(amount, { type: 'i128' }),
  ];

  try {
    const result = await withChannel('channel', (lease) =>
      invokeAsMaster({
        appId,
        masterAccount: context.masterAccount,
        contractId: env.ANCHOR_CONTRACT_ID,
        fn: 'register',
        args,
        contextRuleId: context.grant.contextRuleId!,
        payer: lease.keypair,
      }),
    );

    await master.confirmEntry(entryId, result.hash);
    logger.info({ appId, kind, reference, hash: result.hash }, 'evento ancorado');

    return c.json({
      success: true,
      hash: result.hash,
      contract: env.ANCHOR_CONTRACT_ID,
      payloadHash: hash,
      entryId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await master.failEntry(entryId, message);

    // 6200 é QuotaExceeded na mint-quota-policy — a mesma policy vigia os dois
    // alvos, e no anchor cada evento custa 1 unidade.
    const quotaHit = message.includes('6200');
    return c.json(
      {
        success: false,
        error: quotaHit ? 'a cota de âncoras concedida pelo tenant acabou' : message,
        errorCode: quotaHit ? 'QUOTA_EXCEEDED' : 'ONCHAIN_FAILED',
      },
      quotaHit ? 403 : 502,
    );
  }
});

/** O histórico de âncoras, com o payload que ficou fora da chain. */
masterRoutes.get('/ledger/records', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  return c.json({
    success: true,
    items: await master.recordsFor(appId, {
      limit,
      offset,
      kind: c.req.query('kind'),
      reference: c.req.query('reference'),
    }),
  });
});

/** Evento sem chave de negócio: o próprio hash serve de identificador. */
function entryFallback(hash: string): string {
  return `anchor:${hash.slice(0, 32)}`;
}

/** O ledger completo do tenant, com o payload que ficou fora da chain. */
masterRoutes.get('/ledger/entries', requireCaller(), async (c) => {
  const { appId } = c.get('caller');
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  return c.json({ success: true, items: await master.entriesFor(appId, limit, offset) });
});

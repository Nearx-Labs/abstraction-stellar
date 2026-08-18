// Registry de smart accounts.
//
// O registro acontece logo depois do createWallet, quando ainda não existe
// sessão — por isso ele aceita a publishable key e valida o que dá para
// validar: o contrato precisa existir on-chain. `external_id` é o campo que um
// backend consumidor usa para achar a conta do seu usuário.
import { Hono } from 'hono';
import { env } from '../env.js';
import { resolveByKey } from '../db/queries/apps.js';
import * as accounts from '../db/queries/accounts.js';
import * as quota from '../db/queries/quota.js';
import * as sponsorships from '../db/queries/sponsorships.js';
import { contractExists, sacBalance } from '../chain/sac.js';
import { getAllowance, getUsageToday } from '../chain/treasury.js';
import { assertCanActOn, requireCaller, requireService } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { logger } from '../logger.js';

export const accountRoutes = new Hono();

const C_ADDRESS = /^C[A-Z2-7]{55}$/;

accountRoutes.post(
  '/accounts',
  rateLimit({ name: 'account-register', limit: 10, windowSeconds: 60 }),
  async (c) => {
    const body = await c.req.json<{
      contractId?: string;
      credentialId?: string;
      publicKeyHex?: string;
      externalId?: string;
      label?: string;
      publishableKey?: string;
      deployTxHash?: string;
    }>();

    if (!body.contractId || !C_ADDRESS.test(body.contractId)) {
      return c.json(
        { success: false, error: 'contractId inválido', errorCode: 'INVALID_PARAMS' },
        400,
      );
    }

    // Aceita publishable key (browser, logo após o deploy) ou secret key
    // (backend consumidor registrando em nome de um usuário).
    const header = c.req.header('Authorization');
    const resolved = body.publishableKey
      ? await resolveByKey(body.publishableKey, 'publishable')
      : header?.toLowerCase().startsWith('bearer ')
        ? await resolveByKey(header.slice(7).trim(), 'secret')
        : null;

    if (!resolved) {
      return c.json({ success: false, error: 'chave inválida', errorCode: 'UNAUTHORIZED' }, 401);
    }

    const exists = await contractExists(body.contractId);
    if (!exists) {
      return c.json(
        {
          success: false,
          error: 'a conta ainda não existe on-chain',
          errorCode: 'ACCOUNT_NOT_DEPLOYED',
        },
        409,
      );
    }

    const account = await accounts.upsert({
      appId: resolved.app.id,
      contractId: body.contractId,
      externalId: body.externalId ?? null,
      label: body.label ?? null,
      status: 'deployed',
      deployTxHash: body.deployTxHash ?? null,
    });

    if (body.credentialId && body.publicKeyHex) {
      const raw = Buffer.from(body.publicKeyHex.replace(/^0x/, ''), 'hex');
      if (raw.length !== 65 || raw[0] !== 0x04) {
        return c.json(
          {
            success: false,
            error: 'publicKeyHex deve ser a chave P-256 não comprimida de 65 bytes',
            errorCode: 'INVALID_PARAMS',
          },
          400,
        );
      }
      await accounts.addCredential({
        accountId: account.id,
        credentialId: body.credentialId,
        publicKeyRaw: raw,
        label: body.label ?? null,
      });
    }

    logger.info({ contractId: account.contractId, appId: resolved.app.id }, 'conta registrada');
    return c.json({
      success: true,
      account: {
        contractId: account.contractId,
        externalId: account.externalId,
        status: account.status,
      },
    });
  },
);

/** Lookup por id externo — o caminho que um backend consumidor usa. */
accountRoutes.get('/accounts', requireService(), async (c) => {
  const externalId = c.req.query('externalId');
  if (!externalId) {
    return c.json(
      { success: false, error: 'externalId é obrigatório', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }
  const caller = c.get('caller');
  const account = await accounts.byExternalId(caller.appId, externalId);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }
  return c.json({
    success: true,
    account: {
      contractId: account.contractId,
      externalId: account.externalId,
      status: account.status,
      createdAt: account.createdAt.toISOString(),
    },
  });
});

accountRoutes.get('/accounts/:address', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const caller = c.get('caller');
  const treasuryId = caller.service?.app.treasuryId ?? env.TREASURY_CONTRACT_ID;

  const [balance, allowance] = await Promise.all([
    sacBalance(address).catch(() => null),
    treasuryId ? getAllowance(treasuryId, address).catch(() => null) : Promise.resolve(null),
  ]);

  return c.json({
    success: true,
    account: {
      contractId: account.contractId,
      externalId: account.externalId,
      label: account.label,
      status: account.status,
      deployTxHash: account.deployTxHash,
      createdAt: account.createdAt.toISOString(),
    },
    balanceStroops: balance === null ? null : balance.toString(),
    allowance: allowance
      ? {
          maxPerTxStroops: allowance.maxPerTx.toString(),
          maxPerDayStroops: allowance.maxPerDay.toString(),
          expiresAt: allowance.expiresAt ? Number(allowance.expiresAt) : null,
        }
      : null,
  });
});

accountRoutes.get('/accounts/:address/usage', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const caller = c.get('caller');
  const resolved = caller.service ?? null;
  const treasuryId = resolved?.app.treasuryId ?? env.TREASURY_CONTRACT_ID;

  const [snapshot, onchainUsage, allowance] = await Promise.all([
    quota.snapshot(caller.appId, address),
    treasuryId ? getUsageToday(treasuryId, address).catch(() => null) : Promise.resolve(null),
    treasuryId ? getAllowance(treasuryId, address).catch(() => null) : Promise.resolve(null),
  ]);

  const now = new Date();
  const resetsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );

  return c.json({
    success: true,
    spentStroops: snapshot.settled.toString(),
    reservedStroops: snapshot.reserved.toString(),
    maxPerDayStroops: (allowance?.maxPerDay ?? env.ALLOWANCE_MAX_PER_DAY).toString(),
    maxPerTxStroops: (allowance?.maxPerTx ?? env.ALLOWANCE_MAX_PER_TX).toString(),
    txCount: snapshot.txCount,
    resetsAt: resetsAt.toISOString(),
    onchain: {
      usageToday: onchainUsage === null ? null : onchainUsage.toString(),
      hasAllowance: allowance !== null,
    },
  });
});

accountRoutes.get('/accounts/:address/sponsorships', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 100);
  const offset = Number(c.req.query('offset') ?? 0);
  return c.json({ success: true, items: await sponsorships.history(address, limit, offset) });
});

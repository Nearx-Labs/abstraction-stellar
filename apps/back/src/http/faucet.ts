// Faucet de testnet — duas pernas numa ação só.
//
//  1. XLM na smart account. O friendbot não financia contract address, então o
//     caminho é transferir pelo SAC a partir de uma conta clássica (a conta de
//     faucet da plataforma). É a mesma mecânica do kit/fund-ops.js, mas com
//     valor fixo, cooldown e registro auditável.
//
//  2. Allowance no Treasury. `set_allowance` é `#[only_owner]` e NADA no
//     projeto chamava essa função — então toda conta nova falhava o débito com
//     NoAllowance (5101), invisivelmente, porque o débito era fire-and-forget.
//     Ativar a cota aqui é o que fecha esse buraco.
//
// A segunda perna vai pelo outbox: o cliente não fica esperando dois blocos, e
// se a escrita falhar ela é retentada em vez de sumir.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { env } from '../env.js';
import { logger } from '../logger.js';
import * as faucet from '../db/queries/faucet.js';
import * as outbox from '../db/queries/outbox.js';
import { pool } from '../db/pool.js';
import { classicBalance, sacTransfer } from '../chain/sac.js';
import { faucet as faucetKey } from '../chain/keys.js';
import { assertCanActOn, requireCaller } from './middleware/auth.js';
import { clientIp, hit } from './middleware/rateLimit.js';

export const faucetRoutes = new Hono();

function treasuryOf(c: Context): string | undefined {
  return c.get('caller').service?.app.treasuryId ?? env.TREASURY_CONTRACT_ID;
}

faucetRoutes.get('/accounts/:address/faucet', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const info = await faucet.cooldown(account.id, env.FAUCET_COOLDOWN_HOURS);
  return c.json({
    success: true,
    amountStroops: env.FAUCET_AMOUNT_STROOPS.toString(),
    cooldownHours: env.FAUCET_COOLDOWN_HOURS,
    blocked: info.blocked,
    nextAvailableAt: info.nextAvailableAt?.toISOString() ?? null,
    last: info.last
      ? {
          state: info.last.state,
          xlmTxHash: info.last.xlmTxHash,
          createdAt: info.last.createdAt.toISOString(),
          error: info.last.error,
        }
      : null,
  });
});

faucetRoutes.post('/accounts/:address/faucet', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const caller = c.get('caller');

  if (!(await hit(`faucet:${clientIp(c)}`, 5, 3600))) {
    return c.json(
      { success: false, error: 'muitas tentativas; aguarde', errorCode: 'RATE_LIMITED' },
      429,
    );
  }

  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }
  if (account.status !== 'deployed') {
    return c.json(
      {
        success: false,
        error: 'a conta ainda está sendo implantada',
        errorCode: 'ACCOUNT_NOT_DEPLOYED',
      },
      409,
    );
  }

  const cooldown = await faucet.cooldown(account.id, env.FAUCET_COOLDOWN_HOURS);
  if (cooldown.blocked) {
    return c.json(
      {
        success: false,
        error: 'você já usou o faucet nas últimas 24h',
        errorCode: 'FAUCET_COOLDOWN',
        nextAvailableAt: cooldown.nextAvailableAt?.toISOString() ?? null,
      },
      429,
    );
  }

  const treasuryId = treasuryOf(c);
  const amount = env.FAUCET_AMOUNT_STROOPS;

  // Sem saldo, a transferência falharia depois de já ter aberto o claim.
  try {
    const balance = await classicBalance(faucetKey.publicKey());
    if (balance < env.FAUCET_MIN_BALANCE_STROOPS) {
      logger.error(
        { publicKey: faucetKey.publicKey(), balance },
        'conta de faucet sem saldo suficiente',
      );
      return c.json(
        { success: false, error: 'o faucet está sem saldo', errorCode: 'FAUCET_DRY' },
        503,
      );
    }
  } catch (error) {
    logger.error({ err: String(error) }, 'não deu para ler o saldo do faucet');
  }

  let claimId: string;
  try {
    claimId = await faucet.open({
      appId: caller.appId,
      accountId: account.id,
      smartAccount: address,
      amountStroops: amount,
      requesterIp: clientIp(c),
    });
  } catch (error) {
    if (error instanceof faucet.ClaimInFlightError) {
      return c.json({ success: false, error: error.message, errorCode: error.code }, 409);
    }
    throw error;
  }

  // Perna 1 — XLM.
  try {
    const { hash } = await sacTransfer(faucetKey, address, amount);
    await faucet.markXlmSent(claimId, hash);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await faucet.markFailed(claimId, message);
    logger.error({ address, err: message }, 'perna do XLM falhou');
    return c.json(
      { success: false, error: 'não deu para enviar o XLM agora', errorCode: 'FAUCET_FAILED' },
      502,
    );
  }

  // Perna 2 — allowance no Treasury, via outbox.
  let outboxId: string | null = null;
  if (treasuryId) {
    const expiresAt =
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(env.ALLOWANCE_TTL_DAYS) * 86_400n;
    outboxId = await outbox.enqueue(pool, {
      appId: caller.appId,
      kind: 'set_allowance',
      dedupeKey: `set_allowance:${address}:${claimId}`,
      payload: {
        appId: caller.appId,
        treasuryId,
        user: address,
        maxPerTx: env.ALLOWANCE_MAX_PER_TX.toString(),
        maxPerDay: env.ALLOWANCE_MAX_PER_DAY.toString(),
        expiresAt: expiresAt.toString(),
      },
    });
    await faucet.attachAllowanceJob(claimId, outboxId);
  } else {
    await faucet.markDone(claimId);
  }

  const claim = await faucet.byId(claimId);
  return c.json({
    success: true,
    claimId,
    state: claim?.state ?? 'xlm_sent',
    amountStroops: amount.toString(),
    xlmTxHash: claim?.xlmTxHash ?? null,
    allowancePending: outboxId !== null,
    nextAvailableAt: new Date(
      Date.now() + env.FAUCET_COOLDOWN_HOURS * 3600_000,
    ).toISOString(),
  });
});

/** Reenvia só a perna da allowance — o estado `partial` da tela. */
faucetRoutes.post('/accounts/:address/faucet/allowance', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const caller = c.get('caller');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const treasuryId = treasuryOf(c);
  if (!treasuryId) {
    return c.json(
      { success: false, error: 'treasury não configurado', errorCode: 'NOT_CONFIGURED' },
      409,
    );
  }

  const expiresAt =
    BigInt(Math.floor(Date.now() / 1000)) + BigInt(env.ALLOWANCE_TTL_DAYS) * 86_400n;
  const outboxId = await outbox.enqueue(pool, {
    appId: caller.appId,
    kind: 'set_allowance',
    dedupeKey: `set_allowance:${address}:retry:${Math.floor(Date.now() / 60_000)}`,
    payload: {
      appId: caller.appId,
      treasuryId,
      user: address,
      maxPerTx: env.ALLOWANCE_MAX_PER_TX.toString(),
      maxPerDay: env.ALLOWANCE_MAX_PER_DAY.toString(),
      expiresAt: expiresAt.toString(),
    },
  });

  return c.json({ success: true, queued: outboxId !== null });
});

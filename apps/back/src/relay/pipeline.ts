// O caminho de uma transação patrocinada, do body até a liquidação.
//
// Ordem que importa:
//   parse → montar/simular (é daqui que sai o custo) → policy → RESERVAR a
//   quota → submeter → liquidar com o custo real → enfileirar o débito no
//   Treasury.
//
// Reservar antes de submeter é o que impede duas requisições concorrentes de
// furarem o teto; liquidar depois é o que faz a conta fechar pelo `feeCharged`
// e não pelo teto.
import { xdr } from '@stellar/stellar-sdk';
import { pool, tx } from '../db/pool.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import type { ResolvedApp } from '../db/queries/apps.js';
import * as quota from '../db/queries/quota.js';
import * as sponsorships from '../db/queries/sponsorships.js';
import * as outbox from '../db/queries/outbox.js';
import * as accounts from '../db/queries/accounts.js';
import { NoChannelAvailableError, acquire, release } from '../db/queries/channels.js';
import { channels } from '../chain/keys.js';
import { AmbiguousSponsorError, parseHostFunction, parseTransactionIntent } from '../chain/parse.js';
import type { ParsedIntent } from '../chain/parse.js';
import {
  forwardToChannels,
  prepareFeeBump,
  prepareHostFunction,
  type PreparedSubmission,
} from '../chain/submit.js';
import { PolicyError, enforcePolicy } from './policy.js';

export interface RelayBody {
  func?: string;
  auth?: string[];
  xdr?: string;
}

export interface RelayResult {
  status: number;
  body: Record<string, unknown>;
}

/** Conta sintética para quota quando a transação não tem dono (ex.: upload de WASM). */
const APP_LEVEL_ACCOUNT = '__app__';

/**
 * O contrato que interessa ao Treasury.
 *
 * Numa chamada roteada pelo `execute` da smart account, o alvo do topo é a
 * própria conta — e `Treasury.consume` ignora a allowlist quando user == target.
 * Debitar contra o contrato de fato invocado é o que torna o evento útil.
 */
function sponsoredTarget(intent: ParsedIntent): string | undefined {
  return intent.targets.find((target) => target !== intent.user) ?? intent.targets[0];
}

const RESERVE_SECONDS = 180;
let roundRobin = 0;

function ok(hash: string, status: string): RelayResult {
  return { status: 200, body: { success: true, hash, status } };
}

function err(status: number, message: string, errorCode: string): RelayResult {
  return { status, body: { success: false, error: message, errorCode } };
}

export async function relay(
  resolved: ResolvedApp,
  body: RelayBody,
  idempotencyKey?: string,
): Promise<RelayResult> {
  const { app, policy } = resolved;

  if (idempotencyKey) {
    const prior = await sponsorships.findByIdempotencyKey(app.id, idempotencyKey);
    if (prior?.txHash) return ok(prior.txHash, prior.state === 'succeeded' ? 'SUCCESS' : 'FAILED');
  }

  let intent: ParsedIntent;
  let prepared: PreparedSubmission;
  let mode: 'invoke' | 'feebump';
  let leaseId: string | null = null;

  try {
    if (body.func) {
      mode = 'invoke';
      const hostFn = xdr.HostFunction.fromXDR(body.func, 'base64');
      const authEntries = (body.auth ?? []).map((a) =>
        xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64'),
      );
      intent = parseHostFunction(hostFn, authEntries);

      // Só este caminho consome o sequence number do pagador — um fee-bump não
      // consome o do feeSource. Por isso o lease é só aqui.
      const lease = await acquire('channel');
      leaseId = lease.id;
      prepared = await prepareHostFunction(lease.keypair, hostFn, authEntries);

      if (env.CHANNELS_URL) {
        enforcePolicy(policy, intent, prepared.feeCap);
        const fwd = await forwardToChannels({ func: body.func, auth: body.auth });
        return { status: fwd.status, body: fwd.json as Record<string, unknown> };
      }
    } else if (body.xdr) {
      mode = 'feebump';
      const payer = channels[roundRobin++ % channels.length];
      if (!payer) throw new NoChannelAvailableError();
      const built = await prepareFeeBump(payer, body.xdr);
      intent = parseTransactionIntent(built.inner);
      prepared = built;

      if (env.CHANNELS_URL) {
        enforcePolicy(policy, intent, prepared.feeCap);
        const fwd = await forwardToChannels({ xdr: body.xdr });
        return { status: fwd.status, body: fwd.json as Record<string, unknown> };
      }
    } else {
      return err(400, 'body deve conter {func, auth} ou {xdr}', 'INVALID_PARAMS');
    }

    enforcePolicy(policy, intent, prepared.feeCap);
  } catch (error) {
    if (leaseId) await release(leaseId, String(error));
    return toErrorResult(error);
  }

  const quotaAccount = intent.user ?? APP_LEVEL_ACCOUNT;
  const account = intent.user ? await accounts.byContractId(app.id, intent.user) : null;

  // Reserva + registro numa transação só: ou os dois acontecem, ou nenhum.
  let reservation: { id: string; dayUtc: string };
  try {
    const created = await tx(async (client) => {
      const snap = await quota.reserve(
        client,
        app.id,
        quotaAccount,
        prepared.feeCap,
        policy.maxFeePerDay,
      );
      if (!snap) return null;
      return sponsorships.createReserved(client, {
        appId: app.id,
        accountId: account?.id ?? null,
        smartAccount: quotaAccount,
        mode,
        isDeploy: intent.isDeploy,
        targets: intent.targets,
        reservedStroops: prepared.feeCap,
        channelId: null,
        idempotencyKey: idempotencyKey ?? null,
        reserveSeconds: RESERVE_SECONDS,
      });
    });

    if (!created) {
      if (leaseId) await release(leaseId);
      return err(
        403,
        `cota diária de taxas patrocinadas esgotada para ${quotaAccount}`,
        'FEE_LIMIT_EXCEEDED',
      );
    }
    reservation = created;
  } catch (error) {
    if (leaseId) await release(leaseId);
    return toErrorResult(error);
  }

  // ── Submissão ─────────────────────────────────────────────────────────────
  try {
    const outcome = await prepared.send();
    if (leaseId) await release(leaseId);

    await tx(async (client) => {
      await sponsorships.markSettled(client, reservation.id, {
        status: outcome.status,
        txHash: outcome.hash,
        charged: outcome.status === 'SUCCESS' ? outcome.feeCharged : 0n,
        errorCode: outcome.status === 'SUCCESS' ? undefined : 'ONCHAIN_FAILED',
      });
      await quota.settle(
        client,
        app.id,
        quotaAccount,
        reservation.dayUtc,
        prepared.feeCap,
        outcome.status === 'SUCCESS' ? outcome.feeCharged : 0n,
      );

      // Uma transação revertida não consome cota nem gera débito no Treasury.
      // O relayer antigo debitava os dois de qualquer jeito, porque o status do
      // poll era descartado.
      const debitTarget = sponsoredTarget(intent);
      if (outcome.status === 'SUCCESS' && app.treasuryId && intent.user && debitTarget) {
        await outbox.enqueue(client, {
          appId: app.id,
          kind: 'consume',
          sponsorshipId: reservation.id,
          dedupeKey: `consume:${outcome.hash}`,
          payload: {
            treasuryId: app.treasuryId,
            user: intent.user,
            target: debitTarget,
            amount: outcome.feeCharged.toString(),
          },
        });
      }
    });

    if (outcome.status === 'SUCCESS' && intent.isDeploy && intent.user) {
      await accounts.upsert({
        appId: app.id,
        contractId: intent.user,
        status: 'deployed',
        deployTxHash: outcome.hash,
      });

      // A conta acabou de nascer e o patrocínio do próprio deploy já vai ser
      // debitado nela. Sem allowance, esse débito falharia com NoAllowance e
      // ficaria preso no outbox — a conta existe, foi patrocinada, então recebe
      // a cota agora, sem depender de passar pelo faucet antes.
      if (app.treasuryId) {
        const expiresAt =
          BigInt(Math.floor(Date.now() / 1000)) + BigInt(env.ALLOWANCE_TTL_DAYS) * 86_400n;
        await outbox.enqueue(pool, {
          appId: app.id,
          kind: 'set_allowance',
          dedupeKey: `set_allowance:${intent.user}:deploy`,
          payload: {
            appId: app.id,
            treasuryId: app.treasuryId,
            user: intent.user,
            maxPerTx: env.ALLOWANCE_MAX_PER_TX.toString(),
            maxPerDay: env.ALLOWANCE_MAX_PER_DAY.toString(),
            expiresAt: expiresAt.toString(),
          },
        });
      }
    }

    if (outcome.status !== 'SUCCESS') {
      logger.warn(
        { hash: outcome.hash, status: outcome.status, account: quotaAccount },
        'transação patrocinada não confirmou',
      );
      return {
        status: 502,
        body: {
          success: false,
          error: `transação não confirmou (status=${outcome.status})`,
          errorCode: 'ONCHAIN_FAILED',
          hash: outcome.hash,
        },
      };
    }

    return ok(outcome.hash, outcome.status);
  } catch (error) {
    if (leaseId) await release(leaseId, String(error));
    await tx(async (client) => {
      await sponsorships.markSettled(client, reservation.id, {
        status: 'FAILED',
        charged: 0n,
        errorCode: 'ONCHAIN_FAILED',
      });
      await quota.settle(
        client,
        app.id,
        quotaAccount,
        reservation.dayUtc,
        prepared.feeCap,
        0n,
      );
    });
    return toErrorResult(error);
  }
}

function toErrorResult(error: unknown): RelayResult {
  if (error instanceof PolicyError) return err(403, error.message, error.code);
  if (error instanceof AmbiguousSponsorError) return err(400, error.message, error.code);
  if (error instanceof NoChannelAvailableError) return err(503, error.message, error.code);
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: message }, 'falha no relay');
  return err(500, message, 'ONCHAIN_FAILED');
}

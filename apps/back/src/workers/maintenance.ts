// Manutenção periódica: reservas órfãs, poda de registros efêmeros e saldo das
// contas de serviço.
//
// A reserva órfã é o caso que precisa existir: se o processo morre entre
// reservar a quota e liquidar, aquela conta ficaria com a cota presa até a
// virada do dia.
import { logger } from '../logger.js';
import { reapStaleReservations } from '../db/queries/quota.js';
import { gcExpired } from '../http/middleware/rateLimit.js';
import { recordBalance } from '../db/queries/channels.js';
import { allKeys } from '../chain/keys.js';
import { classicBalance } from '../chain/sac.js';
import { env } from '../env.js';
import { pool } from '../db/pool.js';
import * as outbox from '../db/queries/outbox.js';

const TICK_MS = 30_000;

/** Abaixo disso o serviço para em silêncio — é o alerta mais importante. */
const LOW_BALANCE_STROOPS = 200_000_000n; // 20 XLM

/**
 * Reprovisiona allowances que ficaram abaixo do configurado.
 *
 * Sem isso, subir os tetos só valeria para contas novas: as antigas seguiriam
 * com o valor antigo gravado no Treasury e o `consume` falharia com
 * PerTxLimitExceeded — no outbox, longe da vista de quem usa.
 */
async function refreshStaleAllowances(): Promise<void> {
  const stale = await pool.query<{ app_id: string; contract_id: string; treasury_id: string }>(
    `SELECT a.app_id, a.contract_id, ap.treasury_id
       FROM smart_accounts a
       JOIN apps ap ON ap.id = a.app_id
      WHERE a.allowance_set_at IS NOT NULL
        AND ap.treasury_id <> ''
        AND (a.allowance_max_per_tx  < $1 OR a.allowance_max_per_day < $2)
      LIMIT 20`,
    [env.ALLOWANCE_MAX_PER_TX.toString(), env.ALLOWANCE_MAX_PER_DAY.toString()],
  );

  for (const row of stale.rows) {
    const expiresAt =
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(env.ALLOWANCE_TTL_DAYS) * 86_400n;
    const queued = await outbox.enqueue(pool, {
      appId: row.app_id,
      kind: 'set_allowance',
      // Uma reprovisão por conta por conjunto de tetos — não enfileira em loop.
      dedupeKey: `set_allowance:${row.contract_id}:${env.ALLOWANCE_MAX_PER_TX}:${env.ALLOWANCE_MAX_PER_DAY}`,
      payload: {
        appId: row.app_id,
        treasuryId: row.treasury_id,
        user: row.contract_id,
        maxPerTx: env.ALLOWANCE_MAX_PER_TX.toString(),
        maxPerDay: env.ALLOWANCE_MAX_PER_DAY.toString(),
        expiresAt: expiresAt.toString(),
      },
    });
    if (queued) {
      logger.info(
        { account: row.contract_id, maxPerTx: env.ALLOWANCE_MAX_PER_TX },
        'allowance desatualizada; reprovisionando',
      );
    }
  }
}

async function tick(): Promise<void> {
  await refreshStaleAllowances();

  const released = await reapStaleReservations();
  if (released > 0) logger.warn({ released }, 'reservas órfãs liberadas');

  await gcExpired();

  for (const { role, keypair } of allKeys) {
    try {
      const balance = await classicBalance(keypair.publicKey());
      await recordBalance(keypair.publicKey(), balance);

      const floor = role === 'faucet' ? env.FAUCET_MIN_BALANCE_STROOPS : LOW_BALANCE_STROOPS;
      if (balance < floor) {
        logger.error(
          { role, publicKey: keypair.publicKey(), balance, floor },
          'SALDO BAIXO numa conta de serviço — o patrocínio vai parar',
        );
      }
    } catch {
      // Conta ainda não criada (dev antes do friendbot). O boot cuida disso.
    }
  }
}

export function startMaintenanceWorker(): () => void {
  const timer = setInterval(() => {
    void tick().catch((error) => logger.error({ err: String(error) }, 'manutenção falhou'));
  }, TICK_MS);
  timer.unref();
  void tick().catch(() => {});
  return () => clearInterval(timer);
}

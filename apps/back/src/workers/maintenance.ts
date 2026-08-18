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

const TICK_MS = 30_000;

/** Abaixo disso o serviço para em silêncio — é o alerta mais importante. */
const LOW_BALANCE_STROOPS = 200_000_000n; // 20 XLM

async function tick(): Promise<void> {
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

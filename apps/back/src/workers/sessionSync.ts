// Reconciliação das session keys contra o on-chain.
//
// O DB guarda o metadado, mas quem manda é o contrato: uma regra pode ter sido
// removida por fora do painel, ou ter expirado sozinha pelo valid_until. Sem
// isso, a tela mostraria sessão viva que não existe mais.
import { logger } from '../logger.js';
import * as grants from '../db/queries/sessionGrants.js';
import { getContextRule } from '../chain/account.js';
import { currentLedger } from '../chain/rpc.js';

const TICK_MS = 60_000;

async function tick(): Promise<void> {
  const pending = await grants.needingSync();
  if (pending.length === 0) return;

  const ledger = await currentLedger();

  for (const grant of pending) {
    if (grant.contextRuleId === null) {
      // Grant registrado sem o rule id (o cliente não conseguiu lê-lo na
      // resposta). Sem id não há o que reconciliar; expira pelo relógio.
      if (grant.validUntilLedger !== null && Number(grant.validUntilLedger) < ledger) {
        await grants.setState(grant.id, 'expired');
      } else {
        await grants.touchSynced(grant.id);
      }
      continue;
    }

    const rule = await getContextRule(grant.smartAccount, grant.contextRuleId);

    if (!rule) {
      logger.info(
        { grant: grant.id, ruleId: grant.contextRuleId },
        'context rule sumiu on-chain; marcando como revogada',
      );
      await grants.markRevoked(grant.id);
      continue;
    }

    // Grant sem prazo só sai por revogação — a checagem acima já cobriu isso.
    if (grant.validUntilLedger !== null && Number(grant.validUntilLedger) < ledger) {
      await grants.setState(grant.id, 'expired');
      continue;
    }

    if (grant.state === 'pending') await grants.setState(grant.id, 'active');
    else await grants.touchSynced(grant.id);
  }
}

export function startSessionSyncWorker(): () => void {
  const timer = setInterval(() => {
    void tick().catch((error) => logger.error({ err: String(error) }, 'sessionSync falhou'));
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

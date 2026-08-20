// Worker que leva as escritas do Treasury até o fim.
//
// Substitui o `void debitTreasury(...)` do relayer antigo: lá a resposta HTTP
// saía antes do débito rodar, o resultado nunca era poleado e o erro morria num
// console.error.
//
// O `consume` exige `operator.require_auth()` e o contrato guarda UM operator
// só; Soroban também aceita uma única invokeHostFunction por transação, então
// não dá para batchear débitos. O lease no papel 'operator' serializa entre
// réplicas, e o teto prático fica em ~1 consume por ledger (~17k/dia). Para
// passar disso, `consume` precisaria aceitar um Vec de débitos — o que exige
// redeploy do contrato.
import { logger } from '../logger.js';
import * as outbox from '../db/queries/outbox.js';
import * as accounts from '../db/queries/accounts.js';
import { withChannel } from '../db/queries/channels.js';
import { pool } from '../db/pool.js';
import { allowTarget, consume, setAllowance } from '../chain/treasury.js';
import { owner } from '../chain/keys.js';

const TICK_MS = 2_000;
const BATCH = 5;

async function run(job: outbox.OutboxJob): Promise<string> {
  const p = job.payload as Record<string, string>;

  switch (job.kind) {
    case 'consume': {
      const { hash } = await withChannel('operator', () =>
        consume(p.treasuryId!, p.user!, p.target!, BigInt(p.amount!)),
      );
      return hash;
    }

    case 'set_allowance': {
      const expiresAt = p.expiresAt ? BigInt(p.expiresAt) : undefined;
      const { hash } = await withChannel('owner', () =>
        setAllowance(owner, p.treasuryId!, p.user!, {
          maxPerTx: BigInt(p.maxPerTx!),
          maxPerDay: BigInt(p.maxPerDay!),
          expiresAt,
        }),
      );
      // Espelha no registry para o painel não precisar simular a cada render.
      if (p.appId && p.user) {
        await accounts.recordAllowance(
          p.appId,
          p.user,
          BigInt(p.maxPerTx!),
          BigInt(p.maxPerDay!),
          expiresAt ? new Date(Number(expiresAt) * 1000) : null,
        );
      }
      return hash;
    }

    case 'allow_target': {
      const { hash } = await withChannel('owner', () =>
        allowTarget(owner, p.treasuryId!, p.target!, p.allowed === 'true'),
      );
      return hash;
    }

    default:
      throw new Error(`tipo de job desconhecido: ${job.kind}`);
  }
}

async function tick(): Promise<void> {
  const jobs = await outbox.claim(BATCH);
  for (const job of jobs) {
    try {
      const hash = await run(job);
      await outbox.succeed(job.id, hash);
      logger.info({ job: job.id, kind: job.kind, hash }, 'outbox concluído');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await outbox.fail(job.id, job.attempts, message);
      logger.warn(
        { job: job.id, kind: job.kind, attempts: job.attempts, err: message },
        'outbox falhou; vai retentar',
      );
    }
  }
}

/** Marca claims de faucet cujo set_allowance já concluiu. */
async function completeFaucetClaims(): Promise<void> {
  await pool.query(
    `UPDATE faucet_claims f
        SET state = 'done', completed_at = now()
       FROM treasury_outbox o
      WHERE f.allowance_outbox_id = o.id
        AND o.state = 'done'
        AND f.state IN ('xlm_sent', 'allowance_set')`,
  );
}

export function startTreasuryOutboxWorker(): () => void {
  const timer = setInterval(() => {
    void tick()
      .then(completeFaucetClaims)
      .catch((error) => logger.error({ err: String(error) }, 'tick do outbox falhou'));
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

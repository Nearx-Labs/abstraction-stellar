// Uma escrita por vez em cada contrato.
//
// Os ledgers indexam por contador — `Record(seq)`, `AllAt(supply)`,
// `OwnedAt(dono, n)` — e o footprint de uma transação Soroban é fixado na
// simulação. Duas transações simuladas antes de qualquer uma entrar miram a
// MESMA posição; a primeira aplica, a segunda acessa uma chave fora do próprio
// footprint e trava (`invokeHostFunctionTrapped`). Medido no ensaio local
// (2026-10-12): 6 de 10 âncoras simultâneas falharam assim.
//
// O teto de verdade é ~1 escrita por ledger por contrato (~12/min), com ou sem
// este lock. O lock só faz as excedentes esperarem a vez em vez de queimarem
// fee e voltarem como erro para o consumidor.
//
// Duas camadas, e a ordem importa:
//   1. fila em memória por contrato — quem espera NÃO segura conexão do pool.
//      A primeira versão esperava num advisory lock com uma conexão por
//      requisição: 10 requisições esgotavam o pool (max 10) e quem tinha o lock
//      ficava sem conexão para trabalhar;
//   2. advisory lock no Postgres, tomado só pela cabeça da fila — é o que vale
//      entre réplicas.
import { pool } from '../pool.js';

const POLL_MS = 250;

export class ContractBusyError extends Error {
  readonly code = 'CONTRACT_BUSY';
  constructor(contractId: string) {
    super(`fila de escrita do contrato ${contractId} cheia — tente de novo em instantes`);
  }
}

const queues = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

export async function withContractLock<T>(
  contractId: string,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + waitMs;

  // Entra na fila: a vez chega quando todos os anteriores saírem.
  const previous = queues.get(contractId) ?? Promise.resolve();
  let leave!: () => void;
  const mine = new Promise<void>((resolve) => (leave = resolve));
  const tail = previous.then(() => mine);
  queues.set(contractId, tail);

  try {
    const timedOut = await Promise.race([
      previous.then(() => false),
      sleep(deadline - Date.now()).then(() => true),
    ]);
    if (timedOut) throw new ContractBusyError(contractId);

    const client = await pool.connect();
    const key = `contract-write:${contractId}`;
    try {
      for (;;) {
        const res = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
          [key],
        );
        if (res.rows[0]?.locked) break;
        if (Date.now() >= deadline) throw new ContractBusyError(contractId);
        await sleep(POLL_MS);
      }
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
    } finally {
      client.release();
    }
  } finally {
    // Sair cedo (timeout) não fura a fila: quem vem depois espera `tail`, que só
    // resolve quando o anterior TAMBÉM saiu.
    leave();
    if (queues.get(contractId) === tail) queues.delete(contractId);
  }
}

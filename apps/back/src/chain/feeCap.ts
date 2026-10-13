// Teto de fee das transações assinadas pela conta mestre.
//
// Esse caminho não passa pela policy do relay nem pela quota de XLM: paga o que
// a simulação devolver. Quando uma entrada arquivou, a simulação já inclui a
// restauração — medido na testnet, um mint de 1 item saiu por 4 e por 11,7 XLM.
// Sem teto, isso (ou um bug) sai pago em silêncio. Com teto, a chamada falha
// com FEE_CAP e o consumidor tenta de novo depois de alguém olhar.
import type { Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { env } from '../env.js';

export class FeeCapError extends Error {
  readonly code = 'FEE_CAP';
  constructor(
    readonly feeStroops: bigint,
    readonly capStroops: bigint,
  ) {
    super(
      `fee de ${feeStroops} stroops acima do teto de ${capStroops} (MASTER_MAX_FEE_STROOPS)` +
        ' — provável restauração de estado arquivado',
    );
  }
}

export function assertWithinFeeCap(tx: Transaction | FeeBumpTransaction): void {
  const fee = BigInt(tx.fee);
  if (fee > env.MASTER_MAX_FEE_STROOPS) {
    throw new FeeCapError(fee, env.MASTER_MAX_FEE_STROOPS);
  }
}

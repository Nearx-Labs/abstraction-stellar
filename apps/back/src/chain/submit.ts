// Montagem, pagamento e liquidação das transações patrocinadas.
//
// Correções em relação ao relayer antigo:
//
//  · A quota era debitada com `BigInt(prepared.fee)` / `BigInt(feeBump.fee)` —
//    o TETO que a transação pode custar, não o que a rede cobrou. Agora o teto
//    só serve para reservar; a liquidação usa o `feeCharged` do resultado.
//
//  · No caminho fee-bump a policy era checada contra `inner.fee`, enquanto o
//    cobrado é `baseFee × (numOps + 1)` com `baseFee = inner.fee + 200` — mais
//    de 2x de sub-enforcement. Agora o teto exposto é o do próprio fee-bump.
//
//  · O status do poll era descartado: `{success: true}` saía mesmo para uma
//    transação revertida, e a quota e o Treasury eram debitados assim mesmo.
//    Agora o status volta para quem chamou decidir.
import {
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { env } from '../env.js';
import { NETWORK_PASSPHRASE, server } from './rpc.js';

export type SettleStatus = 'SUCCESS' | 'FAILED' | 'NOT_FOUND';

export interface SubmitOutcome {
  hash: string;
  status: SettleStatus;
  /** Cobrado de fato pela rede. `0n` quando não deu para ler o resultado. */
  feeCharged: bigint;
}

export interface PreparedSubmission {
  /** Teto que esta transação pode custar — é o que se reserva na quota. */
  feeCap: bigint;
  send(): Promise<SubmitOutcome>;
}

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1000;

function feeChargedOf(result: unknown): bigint {
  const withResult = result as { resultXdr?: { feeCharged(): { toString(): string } } };
  try {
    const charged = withResult.resultXdr?.feeCharged();
    return charged ? BigInt(charged.toString()) : 0n;
  } catch {
    return 0n;
  }
}

async function settle(hash: string): Promise<SubmitOutcome> {
  const result = await server.pollTransaction(hash, {
    attempts: POLL_ATTEMPTS,
    sleepStrategy: () => POLL_INTERVAL_MS,
  });
  return {
    hash,
    status: result.status as SettleStatus,
    feeCharged: feeChargedOf(result),
  };
}

/** Modo `{func, auth}`: o proxy monta, simula, paga e submete. */
export async function prepareHostFunction(
  payer: Keypair,
  hostFn: xdr.HostFunction,
  authEntries: xdr.SorobanAuthorizationEntry[],
): Promise<PreparedSubmission> {
  const account = await server.getAccount(payer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: authEntries }))
    .setTimeout(120)
    .build();

  // prepareTransaction É a simulação: é daqui que sai a fee real (inclui a
  // resource fee do Soroban).
  const prepared = await server.prepareTransaction(tx);

  return {
    feeCap: BigInt(prepared.fee),
    send: async () => {
      prepared.sign(payer);
      const res = await server.sendTransaction(prepared);
      if (res.status === 'ERROR') {
        throw new Error(`submissão rejeitada: ${JSON.stringify(res.errorResult)}`);
      }
      return settle(res.hash);
    },
  };
}

/** Modo `{xdr}`: envelopa em fee-bump preservando a assinatura interna. */
export async function prepareFeeBump(
  payer: Keypair,
  innerXdr: string,
): Promise<PreparedSubmission & { inner: Transaction }> {
  const inner = TransactionBuilder.fromXDR(innerXdr, NETWORK_PASSPHRASE);
  if (inner instanceof FeeBumpTransaction) {
    throw new Error('a transação já é fee-bump');
  }

  const baseFee = (BigInt(inner.fee) + 200n).toString();
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    payer,
    baseFee,
    inner,
    NETWORK_PASSPHRASE,
  );

  return {
    inner,
    // O que a rede pode cobrar é a fee do ENVELOPE, não a interna.
    feeCap: BigInt(feeBump.fee),
    send: async () => {
      feeBump.sign(payer);
      const res = await server.sendTransaction(feeBump);
      if (res.status === 'ERROR') {
        throw new Error(`submissão rejeitada: ${JSON.stringify(res.errorResult)}`);
      }
      return settle(res.hash);
    },
  };
}

/** Encaminha a submissão para o OpenZeppelin Channels, mantendo a policy na frente. */
export async function forwardToChannels(
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(env.CHANNELS_URL!, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.CHANNELS_API_KEY ?? ''}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

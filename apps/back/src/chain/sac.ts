// Stellar Asset Contract (XLM) — saldo e transferência.
//
// O friendbot não financia contract address: ele só cria contas clássicas (G).
// Para pingar XLM numa smart account (C) é preciso transferir pelo SAC a partir
// de uma conta clássica. É o mesmo caminho que o smart-account-kit faz em
// kit/fund-ops.js; aqui a origem é a conta de faucet da plataforma, com valor
// fixo e cooldown, em vez de uma conta descartável do friendbot.
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { env } from '../env.js';
import { NETWORK_PASSPHRASE, server } from './rpc.js';
import { logger } from '../logger.js';

const SAC = () => new Contract(env.XLM_SAC_ADDRESS);

/** Saldo em stroops de qualquer endereço (C ou G) no SAC do XLM. */
export async function sacBalance(address: string): Promise<bigint> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(SAC().call('balance', new Address(address).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return 0n;
  return BigInt(scValToNative(sim.result.retval) as string | number | bigint);
}

/**
 * Saldo XLM de uma conta clássica.
 *
 * Precisa vir do AccountEntry: o SAC nativo mantém o XLM de um G-address no
 * ledger clássico, não numa entrada ContractData, então `sacBalance` não o vê.
 */
export async function classicBalance(publicKey: string): Promise<bigint> {
  const entry = await server.getAccountEntry(publicKey);
  return BigInt(entry.balance().toString());
}

/** Transfere XLM de uma conta clássica para um endereço qualquer, via SAC. */
export async function sacTransfer(
  from: Keypair,
  to: string,
  amountStroops: bigint,
): Promise<{ hash: string; status: string }> {
  const account = await server.getAccount(from.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      SAC().call(
        'transfer',
        new Address(from.publicKey()).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(amountStroops, { type: 'i128' }),
      ),
    )
    .setTimeout(60)
    .build();

  // A autorização exigida é da própria source da transação, então assinar o
  // envelope já cobre — não há auth entry extra para montar.
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(from);

  const res = await server.sendTransaction(prepared);
  if (res.status === 'ERROR') {
    throw new Error(`transferência do faucet rejeitada: ${JSON.stringify(res.errorResult)}`);
  }
  const settled = await server.pollTransaction(res.hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  if (settled.status !== 'SUCCESS') {
    throw new Error(`transferência do faucet não confirmou: status=${settled.status}`);
  }
  logger.info({ to, amountStroops, hash: res.hash }, 'faucet transferiu XLM');
  return { hash: res.hash, status: settled.status };
}

/** True se a conta existe on-chain (checa se a smart account já foi implantada). */
export async function contractExists(contractId: string): Promise<boolean> {
  try {
    const entry = await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
    );
    return Boolean(entry);
  } catch {
    return false;
  }
}

// Cliente do contrato Treasury (contracts/treasury/src/contract.rs).
//
// Escritas passam SEMPRE pelo outbox (workers/treasuryOutbox.ts) — este módulo
// só constrói e submete. O `debitTreasury` antigo era `void`, não poleava e
// engolia o erro: um débito perdido era invisível.
//
// Papéis: `consume` exige o operator; `set_allowance` e `allow_target` são
// `#[only_owner]`. São chaves diferentes (ver chain/keys.ts).
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
import { NETWORK_PASSPHRASE, server } from './rpc.js';
import { operator } from './keys.js';

export interface Allowance {
  maxPerTx: bigint;
  maxPerDay: bigint;
  expiresAt?: bigint;
}

const READ_FEE = '1000';

/** Chama uma função de leitura por simulação — não custa fee nem sequence. */
async function simulateRead(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
  const source = new Account(operator.publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: READ_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`simulação de ${fn} falhou: ${JSON.stringify((sim as { error?: unknown }).error)}`);
  }
  if (!sim.result) return undefined;
  return scValToNative(sim.result.retval);
}

/** Assina e submete uma escrita, esperando o resultado (usado pelo worker). */
async function write(
  signer: Keypair,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<{ hash: string; status: string }> {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: READ_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const res = await server.sendTransaction(prepared);
  if (res.status === 'ERROR') {
    throw new Error(`${fn} rejeitada: ${JSON.stringify(res.errorResult)}`);
  }
  const settled = await server.pollTransaction(res.hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  if (settled.status !== 'SUCCESS') {
    throw new Error(`${fn} não confirmou: status=${settled.status}`);
  }
  return { hash: res.hash, status: settled.status };
}

const addr = (a: string) => new Address(a).toScVal();
const i128 = (v: bigint) => nativeToScVal(v, { type: 'i128' });

function allowanceScVal(a: Allowance): xdr.ScVal {
  // `Option<u64>` em Soroban é o valor cru para Some e Void para None.
  return nativeToScVal(
    {
      max_per_tx: a.maxPerTx,
      max_per_day: a.maxPerDay,
      expires_at: a.expiresAt,
    },
    {
      type: {
        max_per_tx: ['symbol', 'i128'],
        max_per_day: ['symbol', 'i128'],
        expires_at: ['symbol', a.expiresAt === undefined ? undefined : 'u64'],
      },
    } as never,
  );
}

/** Debita o patrocínio. `operator.require_auth()`. */
export function consume(
  treasuryId: string,
  user: string,
  target: string,
  amount: bigint,
): Promise<{ hash: string; status: string }> {
  return write(operator, treasuryId, 'consume', [addr(user), addr(target), i128(amount)]);
}

/** Define os limites de um usuário. `#[only_owner]`. */
export function setAllowance(
  ownerKey: Keypair,
  treasuryId: string,
  user: string,
  allowance: Allowance,
): Promise<{ hash: string; status: string }> {
  return write(ownerKey, treasuryId, 'set_allowance', [addr(user), allowanceScVal(allowance)]);
}

/** Adiciona/remove um contrato da allowlist. `#[only_owner]`. */
export function allowTarget(
  ownerKey: Keypair,
  treasuryId: string,
  target: string,
  allowed: boolean,
): Promise<{ hash: string; status: string }> {
  return write(ownerKey, treasuryId, 'allow_target', [
    addr(target),
    xdr.ScVal.scvBool(allowed),
  ]);
}

export async function getAllowance(
  treasuryId: string,
  user: string,
): Promise<Allowance | null> {
  const raw = (await simulateRead(treasuryId, 'get_allowance', [addr(user)])) as
    | { max_per_tx: bigint; max_per_day: bigint; expires_at?: bigint | null }
    | null
    | undefined;
  if (!raw) return null;
  return {
    maxPerTx: BigInt(raw.max_per_tx),
    maxPerDay: BigInt(raw.max_per_day),
    expiresAt: raw.expires_at === null || raw.expires_at === undefined
      ? undefined
      : BigInt(raw.expires_at),
  };
}

export async function getUsageToday(treasuryId: string, user: string): Promise<bigint> {
  const raw = await simulateRead(treasuryId, 'get_usage_today', [addr(user)]);
  return BigInt((raw ?? 0) as string | number | bigint);
}

export async function isTargetAllowed(treasuryId: string, target: string): Promise<boolean> {
  return Boolean(await simulateRead(treasuryId, 'is_target_allowed', [addr(target)]));
}

/** Dono atual (trait Ownable). `set_allowance` e `allow_target` só respondem a ele. */
export async function getOwner(treasuryId: string): Promise<string | null> {
  const raw = await simulateRead(treasuryId, 'get_owner', []);
  return raw ? String(raw) : null;
}

export async function getOperator(treasuryId: string): Promise<string | null> {
  const raw = await simulateRead(treasuryId, 'get_operator', []);
  return raw ? String(raw) : null;
}

export async function setOperator(
  ownerKey: Keypair,
  treasuryId: string,
  operatorAddress: string,
): Promise<{ hash: string; status: string }> {
  return write(ownerKey, treasuryId, 'set_operator', [addr(operatorAddress)]);
}

export async function balance(treasuryId: string): Promise<bigint> {
  const raw = await simulateRead(treasuryId, 'balance', []);
  return BigInt((raw ?? 0) as string | number | bigint);
}

// Leituras da smart account e da spending-limit policy.
//
// Servidas pelo back e não pelo browser de propósito: montar a lista de
// sessões no cliente custaria N simulações RPC sequenciais por render. Aqui é
// uma chamada, com cache curto.
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

async function simulate(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
  return scValToNative(sim.result.retval);
}

export interface ContextRule {
  id: number;
  name?: string;
  validUntil?: number | null;
}

/**
 * Lê uma context rule. `undefined` quando a regra não existe mais — é assim que
 * o sync descobre que uma sessão foi revogada fora do painel.
 */
export async function getContextRule(
  accountContract: string,
  ruleId: number,
): Promise<ContextRule | undefined> {
  try {
    const raw = (await simulate(accountContract, 'get_context_rule', [
      nativeToScVal(ruleId, { type: 'u32' }),
    ])) as { id?: number; name?: string; valid_until?: number | null } | undefined;
    if (!raw) return undefined;
    return {
      id: Number(raw.id ?? ruleId),
      name: raw.name,
      validUntil: raw.valid_until === undefined ? null : raw.valid_until,
    };
  } catch {
    // Simulação que falha (regra inexistente) é informação, não erro.
    return undefined;
  }
}

export interface SpendingLimitData {
  spendingLimit: bigint;
  periodLedgers: number;
  totalSpent: bigint;
}

export async function getSpendingLimitData(
  policyAddress: string,
  ruleId: number,
  accountContract: string,
): Promise<SpendingLimitData | null> {
  try {
    const raw = (await simulate(policyAddress, 'get_spending_limit_data', [
      nativeToScVal(ruleId, { type: 'u32' }),
      new Address(accountContract).toScVal(),
    ])) as
      | { spending_limit: bigint; period_ledgers: number; cached_total_spent: bigint }
      | undefined;
    if (!raw) return null;
    return {
      spendingLimit: BigInt(raw.spending_limit),
      periodLedgers: Number(raw.period_ledgers),
      totalSpent: BigInt(raw.cached_total_spent ?? 0),
    };
  } catch {
    return null;
  }
}

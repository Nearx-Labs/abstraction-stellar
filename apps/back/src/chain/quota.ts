// Leitura da mint-quota-policy (contracts/mint-quota-policy).
//
// É o número que o tenant precisa ver: quanto da cota concedida o serviço já
// consumiu, lido do contrato e não da nossa contabilidade.
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, server } from './rpc.js';

export interface QuotaData {
  maxItems: number;
  periodLedgers: number;
  used: number;
  windowResetsAt: number;
}

export async function getQuotaData(
  policyAddress: string,
  contextRuleId: number,
  smartAccount: string,
): Promise<QuotaData | null> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(policyAddress).call(
        'get_quota_data',
        nativeToScVal(contextRuleId, { type: 'u32' }),
        new Address(smartAccount).toScVal(),
      ),
    )
    .setTimeout(30)
    .build();

  try {
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;

    const raw = scValToNative(sim.result.retval) as {
      max_items: number;
      period_ledgers: number;
      used: number;
      window_resets_at: number;
    };
    return {
      maxItems: Number(raw.max_items),
      periodLedgers: Number(raw.period_ledgers),
      used: Number(raw.used),
      windowResetsAt: Number(raw.window_resets_at),
    };
  } catch {
    // Policy não instalada para esta regra ainda.
    return null;
  }
}

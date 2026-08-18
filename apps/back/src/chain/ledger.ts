// Leitura do contrato demo-ledger (contracts/demo-ledger).
//
// O mint é escrito pelo browser — quem autoriza é a smart account, então a
// transação nasce lá e chega aqui pelo relay patrocinado. O back só lê, e lê
// por simulação: não custa fee nem sequence.
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

export interface LedgerRecord {
  id: number;
  owner: string;
  name: string;
  uri: string;
  fields: Record<string, string>;
  mintedAt: number;
  mintedLedger: number;
}

async function simulate(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<unknown> {
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

/**
 * `Map<String, String>` do Soroban volta do scValToNative como objeto comum,
 * mas com chaves que podem colidir com protótipo. Normalizar aqui evita
 * surpresa no JSON de saída.
 */
function normalizeFields(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (raw instanceof Map) {
    for (const [key, value] of raw) out[String(key)] = String(value);
    return { ...out };
  }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) out[key] = String(value);
  }
  return { ...out };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRecord(raw: any): LedgerRecord {
  return {
    id: Number(raw.id),
    owner: String(raw.owner),
    name: String(raw.name),
    uri: String(raw.uri ?? ''),
    fields: normalizeFields(raw.fields),
    mintedAt: Number(raw.minted_at ?? 0),
    mintedLedger: Number(raw.minted_ledger ?? 0),
  };
}

export async function totalSupply(contractId: string): Promise<number> {
  const raw = await simulate(contractId, 'total_supply', []);
  return Number(raw ?? 0);
}

export async function page(
  contractId: string,
  offset: number,
  limit: number,
): Promise<LedgerRecord[]> {
  const raw = (await simulate(contractId, 'page', [
    nativeToScVal(offset, { type: 'u32' }),
    nativeToScVal(Math.min(limit, 50), { type: 'u32' }),
  ])) as unknown[] | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map(toRecord);
}

export async function getRecord(
  contractId: string,
  id: number,
): Promise<LedgerRecord | null> {
  try {
    const raw = await simulate(contractId, 'get_record', [
      nativeToScVal(id, { type: 'u32' }),
    ]);
    return raw ? toRecord(raw) : null;
  } catch {
    return null;
  }
}

export async function recordsOf(contractId: string, owner: string): Promise<number[]> {
  const raw = (await simulate(contractId, 'records_of', [
    new Address(owner).toScVal(),
  ])) as unknown[] | undefined;
  return Array.isArray(raw) ? raw.map(Number) : [];
}

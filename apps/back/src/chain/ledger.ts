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
  /** Identificador vindo de fora da chain — a mesma chave do banco consumidor. */
  uuid: string;
  /** Dono atual; muda a cada venda. */
  owner: string;
  /** Quem mintou; não muda — diz de qual tenant o item saiu. */
  minter: string;
  name: string;
  uri: string;
  fields: Record<string, string>;
  mintedAt: number;
  mintedLedger: number;
  transfers: number;
  lastTransferLedger: number;
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
    uuid: String(raw.uuid),
    owner: String(raw.owner),
    minter: String(raw.minter ?? raw.owner),
    name: String(raw.name),
    uri: String(raw.uri ?? ''),
    fields: normalizeFields(raw.fields),
    mintedAt: Number(raw.minted_at ?? 0),
    mintedLedger: Number(raw.minted_ledger ?? 0),
    transfers: Number(raw.transfers ?? 0),
    lastTransferLedger: Number(raw.last_transfer_ledger ?? 0),
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
    // `page` lê 2 entradas por item; o contrato clampa em 40 para caber no
    // footprint.
    nativeToScVal(Math.min(limit, 40), { type: 'u32' }),
  ])) as unknown[] | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map(toRecord);
}

export async function getRecord(
  contractId: string,
  uuid: string,
): Promise<LedgerRecord | null> {
  try {
    const raw = await simulate(contractId, 'get_record', [
      nativeToScVal(uuid, { type: 'string' }),
    ]);
    return raw ? toRecord(raw) : null;
  } catch {
    return null;
  }
}

export async function ownerOf(contractId: string, uuid: string): Promise<string | null> {
  try {
    const raw = await simulate(contractId, 'owner_of', [
      nativeToScVal(uuid, { type: 'string' }),
    ]);
    return raw ? String(raw) : null;
  } catch {
    return null;
  }
}

/** Quantos itens a conta tem. */
export async function balanceOf(contractId: string, owner: string): Promise<number> {
  const raw = await simulate(contractId, 'balance_of', [new Address(owner).toScVal()]);
  return Number(raw ?? 0);
}

/**
 * Uma página dos UUIDs em posse de uma conta. O contrato clampa `limit` em 50;
 * a ordem da lista de um dono não é estável (o transfer tira por troca com o
 * último).
 */
export async function recordsOf(
  contractId: string,
  owner: string,
  start = 0,
  limit = 50,
): Promise<string[]> {
  const raw = (await simulate(contractId, 'records_of', [
    new Address(owner).toScVal(),
    nativeToScVal(start, { type: 'u32' }),
    nativeToScVal(Math.min(limit, 50), { type: 'u32' }),
  ])) as unknown[] | undefined;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** Um lote do cronograma on-chain (demo-ledger v3). `price` em centavos. */
export interface LedgerLot {
  /** Número do lote, a partir de 1 — o mesmo do campo `_lot`. */
  number: number;
  cap: number;
  price: number;
  minted: number;
}

/** O que o tenant anuncia: teto e preço (centavos) de cada lote. */
export interface LotSpecInput {
  cap: number;
  price: number;
}

/**
 * Versão do wasm do ledger. A v1/v2 não têm `version()`: a simulação falha e
 * isso vira 2 — quem pergunta só quer saber se tem lotes (>= 3).
 */
export async function contractVersion(contractId: string): Promise<number> {
  try {
    const raw = await simulate(contractId, 'version', []);
    return raw === undefined ? 2 : Number(raw);
  } catch {
    return 2;
  }
}

/** Cronograma de uma coleção do minter; vazio se não há. */
export async function lotsOf(
  contractId: string,
  minter: string,
  collection: string,
): Promise<LedgerLot[]> {
  const raw = (await simulate(contractId, 'lots', [
    new Address(minter).toScVal(),
    nativeToScVal(collection, { type: 'string' }),
  ])) as Array<{ cap: unknown; price: unknown; minted: unknown }> | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((lot, idx) => ({
    number: idx + 1,
    cap: Number(lot.cap),
    price: Number(lot.price),
    minted: Number(lot.minted),
  }));
}

/** `Vec<LotSpec>` do contrato: struct vira mapa de símbolos em ordem. */
export function lotSpecsScVal(specs: LotSpecInput[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    specs.map((spec) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('cap'),
          val: nativeToScVal(spec.cap, { type: 'u32' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('price'),
          val: nativeToScVal(BigInt(spec.price), { type: 'u64' }),
        }),
      ]),
    ),
  );
}

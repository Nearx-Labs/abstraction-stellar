// Mint no contrato demo-ledger.
//
// A chamada vai pelo `execute` da smart account: a simulação descobre a árvore
// de autorização inteira (o `execute` da conta + o `owner.require_auth()` do
// ledger), a passkey assina, e o relayer patrocina. É o circuito completo da
// abstração de conta num caso de uso concreto.
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { SmartAccountKit } from 'smart-account-kit';
import { CONFIG } from './config';

/** Tetos espelhados de contracts/demo-ledger/src/contract.rs. */
export const LIMITS = {
  maxFields: 16,
  maxKeyLen: 32,
  maxValueLen: 256,
  maxNameLen: 64,
  maxUriLen: 512,
} as const;

export interface CustomField {
  key: string;
  value: string;
}

export interface MintInput {
  /** Identificador gerado fora da chain — a mesma chave que o banco guarda. */
  uuid: string;
  name: string;
  uri: string;
  fields: CustomField[];
}

export const LIMITS_UUID = 64;

/** UUID v4 do browser; é o que o sistema consumidor grava no seu banco. */
export function newUuid(): string {
  return crypto.randomUUID();
}

function fieldsToScVal(fields: CustomField[]): xdr.ScVal {
  // O host valida a ordem das chaves do mapa; `scvSortedMap` cuida disso.
  return xdr.scvSortedMap(
    fields.map(
      (field) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(field.key, { type: 'string' }),
          val: nativeToScVal(field.value, { type: 'string' }),
        }),
    ),
  );
}

export interface MintOutcome {
  hash?: string;
  success: boolean;
  error?: { code?: string; message?: string };
}

export async function mintRecord(
  kit: SmartAccountKit,
  smartAccount: string,
  input: MintInput,
): Promise<MintOutcome> {
  const args = [
    new Address(smartAccount).toScVal(),
    nativeToScVal(input.uuid, { type: 'string' }),
    nativeToScVal(input.name, { type: 'string' }),
    nativeToScVal(input.uri, { type: 'string' }),
    fieldsToScVal(input.fields),
  ];

  const result = (await kit.executeAndSubmit(
    CONFIG.demoLedgerAddress,
    'mint',
    args,
  )) as unknown as MintOutcome;

  return result;
}

/** Transfere a posse — é a venda do marketplace. Exige auth do dono atual. */
export async function transferRecord(
  kit: SmartAccountKit,
  uuid: string,
  to: string,
): Promise<MintOutcome> {
  return (await kit.executeAndSubmit(CONFIG.demoLedgerAddress, 'transfer', [
    nativeToScVal(uuid, { type: 'string' }),
    new Address(to).toScVal(),
  ])) as unknown as MintOutcome;
}

/** Validação local — a mesma que o contrato aplica, para falhar antes da fee. */
export function validateMint(input: MintInput): string | null {
  if (input.uuid.trim().length === 0) return 'Gere um UUID para o item.';
  if (input.uuid.length > LIMITS_UUID) return `O UUID passa de ${LIMITS_UUID} caracteres.`;

  const name = input.name.trim();
  if (name.length === 0) return 'Dê um nome ao item.';
  if (name.length > LIMITS.maxNameLen) return `O nome passa de ${LIMITS.maxNameLen} caracteres.`;
  if (input.uri.length > LIMITS.maxUriLen) return `A URI passa de ${LIMITS.maxUriLen} caracteres.`;

  const filled = input.fields.filter((field) => field.key.trim().length > 0);
  if (filled.length > LIMITS.maxFields) {
    return `O contrato aceita no máximo ${LIMITS.maxFields} campos.`;
  }

  const seen = new Set<string>();
  for (const field of filled) {
    const key = field.key.trim();
    if (key.length > LIMITS.maxKeyLen) {
      return `O campo "${key.slice(0, 12)}…" tem nome maior que ${LIMITS.maxKeyLen} caracteres.`;
    }
    if (field.value.length > LIMITS.maxValueLen) {
      return `O valor de "${key}" passa de ${LIMITS.maxValueLen} caracteres.`;
    }
    if (seen.has(key)) return `O campo "${key}" está repetido.`;
    seen.add(key);
  }

  return null;
}

export function cleanFields(fields: CustomField[]): CustomField[] {
  return fields
    .map((field) => ({ key: field.key.trim(), value: field.value.trim() }))
    .filter((field) => field.key.length > 0);
}

// Mint no contrato demo-ledger.
//
// A chamada vai pelo `execute` da smart account: a simulação descobre a árvore
// de autorização inteira (o `execute` da conta + o `owner.require_auth()` do
// ledger), a passkey assina, e o relayer patrocina. É o circuito completo da
// abstração de conta num caso de uso concreto.
import type { SmartAccountKit } from 'smart-account-kit';
import { CONFIG } from './config';
import { invokeWithAppKey } from './appKey';

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
  /**
   * URI da mídia. O contrato mantém o campo, mas estes itens não têm imagem —
   * o front sempre manda vazio.
   */
  uri: string;
  fields: CustomField[];
}

export const LIMITS_UUID = 64;

/** UUID v4 do browser; é o que o sistema consumidor grava no seu banco. */
export function newUuid(): string {
  return crypto.randomUUID();
}

/** O spec do contrato converte um Map JS para o `Map<String,String>` do Soroban. */
function fieldsToMap(fields: CustomField[]): Map<string, string> {
  return new Map(fields.map((field) => [field.key, field.value]));
}

export interface MintOutcome {
  hash: string;
  /** True quando a permissão do app foi concedida agora (houve uma digital). */
  granted: boolean;
}

/** Registra um item. Assina com a chave do app — sem digital, depois do 1º grant. */
export async function mintRecord(
  kit: SmartAccountKit,
  smartAccount: string,
  input: MintInput,
): Promise<MintOutcome> {
  return invokeWithAppKey(kit, smartAccount, CONFIG.demoLedgerAddress, 'mint', {
    owner: smartAccount,
    uuid: input.uuid,
    name: input.name,
    uri: input.uri,
    fields: fieldsToMap(input.fields),
  });
}

/** Transfere a posse — é a venda do marketplace. */
export async function transferRecord(
  kit: SmartAccountKit,
  smartAccount: string,
  uuid: string,
  to: string,
): Promise<MintOutcome> {
  return invokeWithAppKey(kit, smartAccount, CONFIG.demoLedgerAddress, 'transfer', {
    uuid,
    to,
  });
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

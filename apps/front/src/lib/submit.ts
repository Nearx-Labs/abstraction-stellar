// Submissão de transações da smart account.
//
// Duas armadilhas do fluxo que este módulo centraliza:
//
//  1. `tx.signAndSend()` é o caminho cru do SDK e exige uma função
//     `signTransaction` — ele não sabe da passkey. Quem assina uma transação de
//     smart account é `kit.signAndSubmit`, que assina as auth entries com
//     WebAuthn, RE-SIMULA (a assinatura muda o custo) e só então submete.
//
//  2. `signAndSubmit` NÃO lança em falha on-chain: devolve
//     `{success: false, error}`. Sem checar isso, um erro de contrato passaria
//     por sucesso e a gente registraria no banco algo que não aconteceu.
import type { SmartAccountKit } from 'smart-account-kit';
import type { contract } from '@stellar/stellar-sdk';

export interface SubmittedTx {
  hash: string;
  ledger?: number;
}

export class ContractCallError extends Error {
  constructor(
    message: string,
    public readonly code?: string | number,
  ) {
    super(message);
  }
}

/** Assina com a passkey e submete, transformando falha on-chain em exceção. */
export async function signAndSubmit<T>(
  kit: SmartAccountKit,
  tx: contract.AssembledTransaction<T>,
): Promise<SubmittedTx> {
  const result = await kit.signAndSubmit(tx);

  if (!result.success) {
    const error = (result as { error?: { message?: string; code?: string | number } }).error;
    throw new ContractCallError(
      error?.message ?? 'a transação foi recusada',
      error?.code,
    );
  }

  return { hash: result.hash, ledger: result.ledger };
}

/**
 * Id que a próxima context rule vai receber.
 *
 * `signAndSubmit` devolve só `{success, hash, ledger}` — o valor de retorno do
 * contrato não vem junto, então não dá para ler o id da regra na resposta. Mas
 * `get_context_rules_count` é um contador monotônico (conta inclusive as
 * removidas), então o próximo id é o valor atual. Lido ANTES de submeter.
 */
export async function nextContextRuleId(kit: SmartAccountKit): Promise<number> {
  return kit.rules.count();
}

/**
 * Acha a regra que autoriza uma chave Ed25519.
 *
 * Procurar pela CHAVE, e não pelo nome ou pelo id previsto, é o que torna isso
 * confiável: a chave pública é única e está dentro do signer da regra. Conferir
 * por nome falhava em silêncio quando o formato do retorno não batia — e o
 * efeito era pior do que parece: sem id, a chave não era guardada, e cada ação
 * criava um grant novo, pedindo a passkey de novo.
 *
 * Cai para o id previsto se a enumeração não achar nada (o probe do kit para no
 * rule id 8).
 */
export async function findRuleForSigner(
  kit: SmartAccountKit,
  publicKeyHex: string,
  fallbackId: number,
  targetContract: string,
): Promise<number | null> {
  const wanted = publicKeyHex.toLowerCase();

  try {
    // `getAll` exige um tipo de contexto; a chave do app sempre vive numa
    // regra CallContract, então filtramos por ela.
    const rules = await kit.rules.getAll({
      tag: 'CallContract',
      values: [targetContract],
    } as never);
    for (const rule of rules as Array<{ id: number; signers?: unknown[] }>) {
      for (const signer of rule.signers ?? []) {
        // Signer::External(verifier, key_data) — o key_data de um Ed25519 é a
        // chave pública crua.
        const values = (signer as { values?: unknown[] })?.values;
        const keyData = values?.[1];
        if (!keyData) continue;
        const hex = Buffer.isBuffer(keyData)
          ? keyData.toString('hex')
          : keyData instanceof Uint8Array
            ? Buffer.from(keyData).toString('hex')
            : String(keyData);
        if (hex.toLowerCase() === wanted) return rule.id;
      }
    }
  } catch {
    // Enumeração indisponível: usa o id previsto.
  }

  try {
    const { result } = await kit.rules.get(fallbackId);
    return result ? fallbackId : null;
  } catch {
    return null;
  }
}

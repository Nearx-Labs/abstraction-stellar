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
 * Confere que a regra criada é mesmo a que esperávamos.
 *
 * Best-effort: se duas regras forem criadas ao mesmo tempo pela mesma conta, o
 * id previsto pode ser de outra. Falhar aqui não desfaz nada — só devolve null
 * para o registro nascer `pending` e o worker de sync resolver.
 */
export async function confirmContextRule(
  kit: SmartAccountKit,
  expectedId: number,
  expectedName: string,
): Promise<number | null> {
  try {
    const { result } = await kit.rules.get(expectedId);
    const name = (result as { name?: string })?.name;
    return name === expectedName ? expectedId : null;
  } catch {
    return null;
  }
}

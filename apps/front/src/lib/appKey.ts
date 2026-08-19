// A chave do app — o que faz a conta transacionar sem pedir a digital toda vez.
//
// O problema que isto resolve: por padrão o kit assina tudo com a passkey, ou
// seja, um prompt biométrico por transação. Não é assim que um grant de conta
// abstrata funciona — o usuário aprova UMA vez o que o app pode fazer, e a
// partir daí o app assina sozinho dentro daquele limite.
//
// Como funciona aqui:
//   · a chave do app é criada e guardada neste navegador;
//   · para cada contrato que o app precisa usar, existe uma context rule
//     `CallContract(alvo)` que autoriza essa chave, com teto de gasto;
//   · o grant é pedido na PRIMEIRA vez que o app toca naquele contrato — um
//     toque na digital — e a partir daí as chamadas àquele contrato não pedem
//     mais nada.
//
// Por que um grant por contrato: `CallContract` recebe UM endereço. Um grant
// que valesse para tudo seria a regra Default, e aí a chave do app poderia
// administrar a conta — adicionar signer, mexer em regra, iniciar recovery.
// Aprovar por capacidade é o que mantém o poder da chave limitado ao que ela
// precisa.
import { contract } from '@stellar/stellar-sdk';
import type { SelectedSigner, SmartAccountKit } from 'smart-account-kit';
import { CONFIG } from './config';
import { LEDGERS_PER_DAY, grantSession, signerFor } from './session';
import * as store from './sessionStore';
import { ContractCallError, type SubmittedTx } from './submit';

/** Teto padrão do grant: 100 XLM por dia, por contrato. */
const DEFAULT_LIMIT = 1_000_000_000n;

const NAMES: Record<string, string> = {
  [CONFIG.xlmSacAddress]: 'Transferências (XLM)',
  [CONFIG.demoLedgerAddress]: 'Registro de itens',
};

export interface AppKeyResult {
  signer: SelectedSigner;
  /** True quando o grant acabou de ser criado (houve um toque na digital). */
  granted: boolean;
}

/** Signer do app para um contrato, se o grant já existir neste navegador. */
export function existingSigner(
  smartAccount: string,
  targetContract: string,
): SelectedSigner | null {
  const stored = store.all(smartAccount).find((s) => s.targetContract === targetContract);
  return stored ? signerFor(smartAccount, stored.ruleId) : null;
}

/**
 * Garante que o app pode assinar por conta própria naquele contrato.
 *
 * Se o grant já existe, não pede nada. Se não existe, pede a digital uma vez.
 */
export async function ensureAppKey(
  kit: SmartAccountKit,
  smartAccount: string,
  targetContract: string,
  options?: { limit?: bigint; name?: string },
): Promise<AppKeyResult> {
  const existing = existingSigner(smartAccount, targetContract);
  if (existing) return { signer: existing, granted: false };

  const grant = await grantSession(kit, smartAccount, targetContract, {
    name: options?.name ?? NAMES[targetContract] ?? 'Permissão do app',
    spendingLimit: options?.limit ?? DEFAULT_LIMIT,
    periodLedgers: LEDGERS_PER_DAY,
    // Sem prazo: quem encerra é a revogação, como num grant de dApp.
  });

  if (grant.ruleId === null) {
    throw new ContractCallError(
      'A permissão foi criada mas não deu para confirmar o id da regra. Recarregue e tente de novo.',
      'GRANT_UNCONFIRMED',
    );
  }

  const signer = signerFor(smartAccount, grant.ruleId);
  if (!signer) throw new ContractCallError('A chave do app não ficou guardada.', 'NO_KEY');
  return { signer, granted: true };
}

function unwrap(result: unknown): SubmittedTx {
  const typed = result as {
    success: boolean;
    hash?: string;
    ledger?: number;
    error?: { message?: string; code?: string | number };
  };
  if (!typed.success) {
    throw new ContractCallError(
      typed.error?.message ?? 'a transação foi recusada',
      typed.error?.code,
    );
  }
  return { hash: typed.hash!, ledger: typed.ledger };
}

/** Transfere um token assinando com a chave do app. */
export async function transferWithAppKey(
  kit: SmartAccountKit,
  smartAccount: string,
  tokenContract: string,
  recipient: string,
  amount: number,
): Promise<SubmittedTx & { granted: boolean }> {
  const { signer, granted } = await ensureAppKey(kit, smartAccount, tokenContract);
  const result = await kit.multiSigners.transfer(tokenContract, recipient, amount, [signer]);
  return { ...unwrap(result), granted };
}

/**
 * Cliente do contrato, com o spec baixado da própria rede.
 *
 * Usar o spec do contrato evita montar ScVal na mão: os argumentos vão como
 * valores JS e a conversão sai do tipo declarado. Cacheado porque a busca do
 * spec é uma ida à rede.
 */
const clients = new Map<string, Promise<contract.Client>>();

function clientFor(targetContract: string): Promise<contract.Client> {
  let client = clients.get(targetContract);
  if (!client) {
    client = contract.Client.from({
      contractId: targetContract,
      networkPassphrase: CONFIG.networkPassphrase,
      rpcUrl: CONFIG.rpcUrl,
      allowHttp: CONFIG.rpcUrl.startsWith('http://'),
    });
    clients.set(targetContract, client);
  }
  return client;
}

/**
 * Invoca um contrato assinando com a chave do app.
 *
 * A chamada é DIRETA ao contrato, não pelo `execute` da conta: pelo `execute` o
 * contexto autorizado seria a própria conta, e a regra `CallContract(alvo)` não
 * casaria — só a Default casaria, que é justamente o que a chave do app não
 * pode ter.
 */
export async function invokeWithAppKey(
  kit: SmartAccountKit,
  smartAccount: string,
  targetContract: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<SubmittedTx & { granted: boolean }> {
  const { signer, granted } = await ensureAppKey(kit, smartAccount, targetContract);

  const client = await clientFor(targetContract);
  const method = (client as unknown as Record<string, (a: unknown) => Promise<unknown>>)[fn];
  if (typeof method !== 'function') {
    throw new ContractCallError(`o contrato não expõe ${fn}`, 'UNKNOWN_FN');
  }

  const assembled = (await method.call(client, args)) as contract.AssembledTransaction<unknown>;
  const result = await kit.multiSigners.operation(assembled, [signer]);
  return { ...unwrap(result), granted };
}

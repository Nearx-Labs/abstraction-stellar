// Leitura da intenção de uma transação: o que ela invoca e quem ela cobra.
//
// Duas correções em relação ao relayer antigo:
//
//  1. `createContract(V2)` era ignorado. Como `parseHostFunction` só olhava
//     `invokeContract`, um deploy chegava com `targets = []` e, porque as auth
//     entries do deploy usam credencial `sourceAccount` (o deployer assina) e
//     não `Address`, também com `user = undefined`. Resultado: a operação mais
//     cara do produto não passava pela allowlist, não debitava quota e nunca
//     chegava ao Treasury. Agora o alvo/pagador é a própria conta que nasce,
//     derivada do preimage.
//
//  2. `user` era a PRIMEIRA credencial `Address` encontrada (com `break`). Com
//     session key + policy, ou multi-signer, isso podia cobrar a conta errada.
//     Agora coletamos todas e exigimos que sejam a mesma.
import { Address, xdr } from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import { contractAddressFromPreimage } from './derive.js';

export interface ParsedIntent {
  /** Contratos invocados (para a allowlist). */
  targets: string[];
  /** Smart account a quem a taxa é cobrada. */
  user?: string;
  /** True quando a transação cria uma conta (host function createContract*). */
  isDeploy: boolean;
}

export class AmbiguousSponsorError extends Error {
  readonly code = 'AMBIGUOUS_SPONSOR';
  constructor(accounts: string[]) {
    super(
      `a transação autoriza mais de uma conta (${accounts.join(', ')}); ` +
        'não dá para decidir quem paga',
    );
  }
}

function addressCredentials(entries: xdr.SorobanAuthorizationEntry[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    const creds = entry.credentials();
    if (creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
      found.add(Address.fromScAddress(creds.address().address()).toString());
    }
  }
  return [...found];
}

/**
 * Contratos alcançados pela árvore de autorização, incluindo sub-invocações.
 *
 * Sem isto a allowlist é contornável: uma chamada roteada pelo
 * `execute(target, fn, args)` da smart account tem, no topo, a própria conta
 * como contrato invocado — e a policy libera a conta chamando a si mesma. O
 * contrato de verdade só aparece um nível abaixo, na sub-invocação.
 */
function invokedContracts(entries: xdr.SorobanAuthorizationEntry[]): string[] {
  const found = new Set<string>();

  const walk = (invocation: xdr.SorobanAuthorizedInvocation): void => {
    const fn = invocation.function();
    if (
      fn.switch() ===
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
    ) {
      found.add(Address.fromScAddress(fn.contractFn().contractAddress()).toString());
    }
    for (const sub of invocation.subInvocations()) walk(sub);
  };

  for (const entry of entries) walk(entry.rootInvocation());
  return [...found];
}

export function parseHostFunction(
  hostFn: xdr.HostFunction,
  authEntries: xdr.SorobanAuthorizationEntry[],
): ParsedIntent {
  const targets: string[] = [];
  let isDeploy = false;
  let deployed: string | undefined;

  switch (hostFn.switch()) {
    case xdr.HostFunctionType.hostFunctionTypeInvokeContract():
      targets.push(Address.fromScAddress(hostFn.invokeContract().contractAddress()).toString());
      break;

    case xdr.HostFunctionType.hostFunctionTypeCreateContractV2():
      isDeploy = true;
      deployed = contractAddressFromPreimage(hostFn.createContractV2().contractIdPreimage());
      targets.push(deployed);
      break;

    case xdr.HostFunctionType.hostFunctionTypeCreateContract():
      isDeploy = true;
      deployed = contractAddressFromPreimage(hostFn.createContract().contractIdPreimage());
      targets.push(deployed);
      break;

    case xdr.HostFunctionType.hostFunctionTypeUploadContractWasm():
      // Upload de WASM não tem alvo nem dono; é tratado como deploy para cair
      // no gate `allow_deploy` em vez de passar despercebido.
      isDeploy = true;
      break;
  }

  const signers = addressCredentials(authEntries);
  if (signers.length > 1) throw new AmbiguousSponsorError(signers);

  // Num deploy não existe credencial Address (quem assina é o deployer), então
  // a conta cobrada é a que está sendo criada.
  const user = signers[0] ?? deployed;

  // A árvore de auth revela os contratos que a transação realmente alcança.
  for (const contract of invokedContracts(authEntries)) {
    if (!targets.includes(contract)) targets.push(contract);
  }

  return { targets, user, isDeploy };
}

export function parseTransactionIntent(tx: Transaction): ParsedIntent {
  const targets: string[] = [];
  const users = new Set<string>();
  let isDeploy = false;

  for (const op of tx.operations) {
    if (op.type !== 'invokeHostFunction') continue;
    const parsed = parseHostFunction(op.func, op.auth ?? []);
    targets.push(...parsed.targets);
    if (parsed.user) users.add(parsed.user);
    isDeploy ||= parsed.isDeploy;
  }

  if (users.size > 1) throw new AmbiguousSponsorError([...users]);
  return { targets, user: [...users][0], isDeploy };
}

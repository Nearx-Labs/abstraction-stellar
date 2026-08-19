// Session keys — o grant que um app recebe da conta.
//
// O modelo é o de um grant de dApp, não o de uma sessão com relógio: a
// permissão é definida por ESCOPO e LIMITE, e vale até ser revogada.
//
//   · escopo: context rule `CallContract(alvo)` — o grant fala com UM contrato
//     e, por construção, não administra a conta (add/remove signer, rules e
//     recovery ficam de fora);
//   · limite: spending-limit policy — teto de gasto numa janela deslizante que
//     se renova sozinha, o análogo de uma allowance periódica;
//   · fim: revogação explícita. O prazo (`valid_until`) passa a ser OPCIONAL,
//     para quem quiser um grant temporário.
//
// A chave é persistida localmente (lib/sessionStore.ts). Sem isso um grant sem
// prazo não faria sentido: recarregar a página perderia a chave e deixaria a
// regra viva on-chain sem ninguém para usá-la — foi por isso que a versão
// anterior precisava de prazo curto.
import { Keypair, rpc } from '@stellar/stellar-sdk';
import {
  createCallContractContext,
  createEd25519Signer,
  LEDGERS_PER_HOUR,
  type SelectedSigner,
  type SmartAccountKit,
} from 'smart-account-kit';
import { CONFIG } from './config';
import { endpoints } from './api';
import { spendingLimitParams } from './policyParams';
import { findRuleForSigner, nextContextRuleId, signAndSubmit } from './submit';
import * as store from './sessionStore';

export const LEDGERS_PER_DAY = LEDGERS_PER_HOUR * 24;

export interface SessionGrant {
  ruleId: number | null;
  publicKey: string;
  /** Ledger de expiração, ou null quando o grant não expira. */
  validUntil: number | null;
  signer: SelectedSigner;
}

export interface SessionOptions {
  /** Janela do teto de gasto, em ledgers. Default: 1 dia. */
  periodLedgers?: number;
  /** Teto de gasto na janela, em stroops. Default: 10 XLM. */
  spendingLimit?: bigint;
  /**
   * Prazo do grant, em ledgers. Omitir = sem prazo (o normal): quem encerra é
   * a revogação.
   */
  ttlLedgers?: number;
  name?: string;
}

/**
 * Monta o SelectedSigner de uma chave guardada.
 *
 * O campo `signer` é obrigatório na prática, embora o tipo o marque como
 * opcional: o kit resolve quais context rules amarram o digest a partir de
 * `selectedSigners.map(({ signer }) => signer)`. Sem ele a lista fica vazia, a
 * regra `CallContract` não é encontrada e a assinatura cai na regra Default —
 * ou seja, pede a passkey mesmo com o grant ativo.
 */
function signerFromSecret(secret: string, label: string): SelectedSigner {
  const keypair = Keypair.fromSecret(secret);
  return {
    type: 'ed25519',
    ed25519PublicKey: keypair.rawPublicKey().toString('hex'),
    label,
    signer: createEd25519Signer(CONFIG.ed25519VerifierAddress, keypair.rawPublicKey()),
  };
}

/** Recarrega no kit as chaves guardadas, para elas voltarem a assinar. */
export function restoreSessions(kit: SmartAccountKit, smartAccount: string): number {
  const stored = store.all(smartAccount);
  for (const session of stored) {
    try {
      kit.externalSigners.addEd25519FromSecret(session.secret);
    } catch {
      // Chave corrompida no storage: some no próximo prune.
    }
  }
  return stored.length;
}

export function hasLiveKey(smartAccount: string, ruleId: number | null): boolean {
  return ruleId !== null && store.load(smartAccount, ruleId) !== null;
}

export function signerFor(smartAccount: string, ruleId: number): SelectedSigner | null {
  const stored = store.load(smartAccount, ruleId);
  return stored ? signerFromSecret(stored.secret, stored.name) : null;
}

/** Descarta chaves de regras que sumiram on-chain. */
export function pruneSessions(smartAccount: string, liveRuleIds: number[]): void {
  store.prune(smartAccount, new Set(liveRuleIds));
}

/** Concede o grant a um app. Um toque na passkey. */
export async function grantSession(
  kit: SmartAccountKit,
  smartAccount: string,
  targetContract: string,
  options?: SessionOptions,
): Promise<SessionGrant> {
  const periodLedgers = options?.periodLedgers ?? LEDGERS_PER_DAY;
  const limit = options?.spendingLimit ?? 100_000_000n;
  const name = options?.name ?? 'Sessão do app';

  const keypair = Keypair.random();
  kit.externalSigners.addEd25519FromSecret(keypair.secret());

  let validUntil: number | null = null;
  if (options?.ttlLedgers) {
    const server = new rpc.Server(CONFIG.rpcUrl);
    const { sequence } = await server.getLatestLedger();
    validUntil = sequence + options.ttlLedgers;
  }

  const signer = createEd25519Signer(CONFIG.ed25519VerifierAddress, keypair.rawPublicKey());
  // Os params vão como ScVal: o `Spec` não converte objeto simples para `Val`.
  const policies = new Map<string, unknown>([
    [CONFIG.spendingLimitPolicyAddress, spendingLimitParams(limit, periodLedgers)],
  ]);

  // O id precisa ser lido ANTES: a resposta da submissão não traz o retorno do
  // contrato, e o contador é monotônico — o próximo id é o valor atual.
  const expectedRuleId = await nextContextRuleId(kit);

  const tx = await kit.rules.add(
    createCallContractContext(targetContract),
    name,
    [signer],
    policies,
    validUntil ?? undefined,
  );
  const result = await signAndSubmit(kit, tx);
  const ruleId = await findRuleForSigner(
    kit,
    keypair.rawPublicKey().toString('hex'),
    expectedRuleId,
    targetContract,
  );

  if (ruleId !== null) {
    store.save(smartAccount, {
      ruleId,
      secret: keypair.secret(),
      publicKey: keypair.rawPublicKey().toString('hex'),
      name,
      targetContract,
      createdAt: Date.now(),
    });
  }

  await endpoints.createSession(smartAccount, {
    contextRuleId: ruleId,
    name,
    targetContract,
    ed25519PublicKey: keypair.rawPublicKey().toString('hex'),
    policyAddress: CONFIG.spendingLimitPolicyAddress,
    spendingLimitStroops: limit.toString(),
    periodLedgers,
    validUntilLedger: validUntil === null ? null : String(validUntil),
    grantTxHash: result.hash,
  });

  return {
    ruleId,
    publicKey: keypair.rawPublicKey().toString('hex'),
    validUntil,
    signer: signerFromSecret(keypair.secret(), name),
  };
}

/** Usa o grant — sem prompt de passkey. */
export function transferWithSession(
  kit: SmartAccountKit,
  signer: SelectedSigner,
  tokenContract: string,
  recipient: string,
  amount: number,
) {
  return kit.multiSigners.transfer(tokenContract, recipient, amount, [signer]);
}

/** Revoga o grant imediatamente (assinado com a passkey). */
export async function revokeSession(
  kit: SmartAccountKit,
  smartAccount: string,
  ruleId: number,
): Promise<void> {
  const tx = await kit.rules.remove(ruleId);
  const result = await signAndSubmit(kit, tx);
  store.remove(smartAccount, ruleId);
  await endpoints.revokeSession(smartAccount, ruleId, result.hash);
}

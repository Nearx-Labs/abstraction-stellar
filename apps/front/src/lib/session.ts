// Session keys: UX fluida sem pedir a passkey a cada ação.
//
// Depois de um login forte com passkey, a conta autoriza uma chave Ed25519
// efêmera numa context rule com três guarda-corpos on-chain:
//   · escopo: CallContract(alvo) — a sessão fala com UM contrato e, por
//     construção, não administra a conta;
//   · expiração: valid_until em ledgers — a sessão morre sozinha;
//   · valor: spending-limit policy — teto de gasto numa janela deslizante.
//
// A chave privada nunca sai da memória desta aba. É proposital, mas tem uma
// consequência de UX que a tela precisa dizer em voz alta: recarregar a página
// perde a chave, enquanto a regra continua viva on-chain até expirar.
import { Keypair, rpc } from '@stellar/stellar-sdk';
import {
  createCallContractContext,
  createEd25519Signer,
  createSpendingLimitParams,
  LEDGERS_PER_HOUR,
  type SelectedSigner,
  type SmartAccountKit,
} from 'smart-account-kit';
import { CONFIG } from './config';
import { endpoints } from './api';

export interface SessionGrant {
  ruleId: number | null;
  publicKey: string;
  validUntil: number;
  signer: SelectedSigner;
}

export interface SessionOptions {
  ttlLedgers?: number;
  spendingLimit?: bigint;
  name?: string;
}

/** Sessões vivas nesta aba, por rule id. Não sobrevive a reload — de propósito. */
const liveSessions = new Map<number, SessionGrant>();

export const liveSessionFor = (ruleId: number): SessionGrant | undefined =>
  liveSessions.get(ruleId);

export const hasLiveKey = (ruleId: number | null): boolean =>
  ruleId !== null && liveSessions.has(ruleId);

function readRuleId(result: unknown): number | null {
  const id = (result as { result?: { id?: number } })?.result?.id;
  // O relayer pode devolver só o hash. Sem id, o registro nasce `pending` e o
  // worker de sync o resolve — melhor do que gravar -1 e fingir que deu certo.
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Cria e autoriza uma session key para `targetContract`, e registra o
 * metadado na API. Pede a passkey uma única vez.
 */
export async function grantSession(
  kit: SmartAccountKit,
  smartAccount: string,
  targetContract: string,
  options?: SessionOptions,
): Promise<SessionGrant> {
  const ttl = options?.ttlLedgers ?? LEDGERS_PER_HOUR;
  const limit = options?.spendingLimit ?? 100_000_000n;
  const name = options?.name ?? 'Sessão do app';

  const keypair = Keypair.random();
  kit.externalSigners.addEd25519FromSecret(keypair.secret());

  const server = new rpc.Server(CONFIG.rpcUrl);
  const { sequence } = await server.getLatestLedger();
  const validUntil = sequence + ttl;

  const signer = createEd25519Signer(
    CONFIG.ed25519VerifierAddress,
    keypair.rawPublicKey(),
  );
  const policies = new Map<string, unknown>([
    [CONFIG.spendingLimitPolicyAddress, createSpendingLimitParams(limit, ttl)],
  ]);

  const tx = await kit.rules.add(
    createCallContractContext(targetContract),
    name,
    [signer],
    policies,
    validUntil,
  );
  const result = await tx.signAndSend();
  const ruleId = readRuleId(result);

  const grant: SessionGrant = {
    ruleId,
    publicKey: keypair.rawPublicKey().toString('hex'),
    validUntil,
    signer: {
      type: 'ed25519',
      ed25519PublicKey: keypair.rawPublicKey().toString('hex'),
      label: name,
    },
  };

  if (ruleId !== null) liveSessions.set(ruleId, grant);

  await endpoints.createSession(smartAccount, {
    contextRuleId: ruleId,
    name,
    targetContract,
    ed25519PublicKey: grant.publicKey,
    policyAddress: CONFIG.spendingLimitPolicyAddress,
    spendingLimitStroops: limit.toString(),
    periodLedgers: ttl,
    validUntilLedger: String(validUntil),
    grantTxHash: (result as { hash?: string })?.hash,
  });

  return grant;
}

/** Transfere usando a session key — sem prompt de passkey. */
export function transferWithSession(
  kit: SmartAccountKit,
  grant: SessionGrant,
  tokenContract: string,
  recipient: string,
  amount: number,
) {
  return kit.multiSigners.transfer(tokenContract, recipient, amount, [grant.signer]);
}

/** Revoga a sessão imediatamente (assinado com a passkey). */
export async function revokeSession(
  kit: SmartAccountKit,
  smartAccount: string,
  ruleId: number,
): Promise<void> {
  const tx = await kit.rules.remove(ruleId);
  const result = await tx.signAndSend();
  liveSessions.delete(ruleId);
  await endpoints.revokeSession(smartAccount, ruleId, (result as { hash?: string })?.hash);
}

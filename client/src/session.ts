// Fase 4 — session keys: UX fluida sem pedir passkey a cada ação.
//
// Depois de um login forte com passkey, a conta autoriza uma chave Ed25519
// efêmera (gerada aqui, guardada só em memória) numa context rule com três
// guarda-corpos on-chain:
//   * escopo: `CallContract(alvo)` — a sessão só fala com UM contrato e,
//     por construção, não administra a conta (add/remove signer, recovery e
//     rules ficam fora do escopo);
//   * expiração: `valid_until` em ledgers — a sessão morre sozinha;
//   * valor: spending-limit policy — teto de gasto numa janela deslizante.
// Revogação imediata via passkey a qualquer momento.
import { Keypair, rpc } from '@stellar/stellar-sdk';
import {
  SmartAccountKit,
  createCallContractContext,
  createEd25519Signer,
  createSpendingLimitParams,
  LEDGERS_PER_HOUR,
  type SelectedSigner,
} from 'smart-account-kit';
import { TESTNET_CONFIG } from './config';

export interface SessionGrant {
  ruleId: number;
  /** Chave pública da sessão (hex, 32 bytes). */
  publicKey: string;
  /** Ledger em que a sessão expira. */
  validUntil: number;
  /** SelectedSigner para assinar ações com esta sessão. */
  signer: SelectedSigner;
}

export interface SessionOptions {
  /** Duração em ledgers (~5s cada). Default: ~1h. */
  ttlLedgers?: number;
  /** Teto de gasto na janela da sessão, em stroops. Default: 10 XLM. */
  spendingLimit?: bigint;
  name?: string;
}

/**
 * Cria e autoriza uma session key para `targetContract`. Pede a passkey uma
 * única vez (para assinar o grant); as ações seguintes usam a chave efêmera.
 */
export async function grantSession(
  kit: SmartAccountKit,
  targetContract: string,
  options?: SessionOptions,
): Promise<SessionGrant> {
  const ttl = options?.ttlLedgers ?? LEDGERS_PER_HOUR;
  const limit = options?.spendingLimit ?? 100_000_000n; // 10 XLM

  // Chave efêmera: nunca sai da memória do kit; sem persistência.
  const keypair = Keypair.random();
  kit.externalSigners.addEd25519FromSecret(keypair.secret());

  const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
  const { sequence } = await server.getLatestLedger();
  const validUntil = sequence + ttl;

  const signer = createEd25519Signer(
    TESTNET_CONFIG.ed25519VerifierAddress,
    keypair.rawPublicKey(),
  );
  const policies = new Map<string, unknown>([
    [
      TESTNET_CONFIG.spendingLimitPolicyAddress,
      createSpendingLimitParams(limit, ttl),
    ],
  ]);

  // Grant assinado com a passkey (regra Default da conta).
  const tx = await kit.rules.add(
    createCallContractContext(targetContract),
    options?.name ?? 'session',
    [signer],
    policies,
    validUntil,
  );
  const result = await tx.signAndSend();
  const ruleId = (result as { result?: { id?: number } }).result?.id ?? -1;

  return {
    ruleId,
    publicKey: keypair.rawPublicKey().toString('hex'),
    validUntil,
    signer: {
      type: 'ed25519',
      ed25519PublicKey: keypair.rawPublicKey().toString('hex'),
      label: options?.name ?? 'session',
    },
  };
}

/**
 * Transfere usando a session key — sem prompt de passkey. O contrato aplica
 * escopo, expiração e spending limit; estourou, a transação falha.
 */
export async function transferWithSession(
  kit: SmartAccountKit,
  session: SessionGrant,
  tokenContract: string,
  recipient: string,
  amount: number,
) {
  return kit.multiSigners.transfer(tokenContract, recipient, amount, [session.signer]);
}

/** Revoga a sessão imediatamente (assinado com a passkey). */
export async function revokeSession(kit: SmartAccountKit, session: SessionGrant) {
  const tx = await kit.rules.remove(session.ruleId);
  return tx.signAndSend();
}

// Fase 2 — login por email como authenticator adicional da smart account.
//
// O fluxo troca a verificação pesada on-chain por uma attestation curta:
//   1. requestOtp/verifyOtp provam posse do email ao Auth Issuer (off-chain);
//   2. registerEmailSigner grava o signer (issuer + subject) numa context
//      rule restrita a UM contrato-alvo — email sozinho nunca administra a
//      conta nem autoriza outros contratos;
//   3. a cada transação, requestAttestation devolve o sig_data (attestation
//      assinada pelo issuer,). O challenge é o auth digest exato da
//      transação, então replay em outra tx/rede/regra é inválido por
//      construção.
import {
  SmartAccountKit,
  createCallContractContext,
  createExternalSigner,
} from 'smart-account-kit';
import { TESTNET_CONFIG } from './config';

const ISSUER_URL = TESTNET_CONFIG.authIssuerUrl;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ISSUER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `issuer error ${res.status}`);
  return json as T;
}

/** Pede o OTP (em dev, o código aparece no console do serviço). */
export function requestOtp(email: string): Promise<{ ok: boolean }> {
  return post('/auth/request', { email });
}

export interface EmailSession {
  token: string;
  subjectHash: string;
  /** hex: issuer pubkey (32) || subject hash (32) — o key_data do signer. */
  keyData: string;
}

/** Confirma o OTP e abre uma sessão curta com o issuer. */
export function verifyOtp(email: string, code: string): Promise<EmailSession> {
  return post('/auth/verify', { email, code });
}

/**
 * Pede uma attestation vinculada ao auth digest da transação (hex, 32
 * bytes). O retorno é o sig_data (XDR base64) para o AuthPayload.
 */
export function requestAttestation(
  token: string,
  challengeHex: string,
): Promise<{ sigDataXdr: string; expiresAt: string }> {
  return post('/attest', { token, challenge: challengeHex });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Registra o email como signer numa context rule `CallContract(target)`.
 * Requer sessão conectada com a passkey (a regra é autorizada pelo signer
 * primário da conta).
 */
export async function registerEmailSigner(
  kit: SmartAccountKit,
  session: EmailSession,
  targetContract: string,
  options?: { name?: string; validUntil?: number },
) {
  const signer = createExternalSigner(
    TESTNET_CONFIG.emailVerifierAddress,
    hexToBytes(session.keyData),
  );
  const tx = await kit.rules.add(
    createCallContractContext(targetContract),
    options?.name ?? 'email',
    [signer],
    new Map(),
    options?.validUntil,
  );
  return tx.signAndSend();
}

// Verificação de assertion WebAuthn (P-256 / ES256).
//
// Por que à mão em vez de @simplewebauthn/server: as bibliotecas guardam a
// chave em COSE, e o que temos é a chave crua de 65 bytes (0x04 || x || y) —
// é o formato que a smart account usa no key_data do webauthn-verifier. Em vez
// de manter duas representações e convertê-las, verificamos direto com o
// `crypto` do Node, que aceita JWK.
//
// Esta assertion NÃO autoriza transação nenhuma — ela só prova, para o painel,
// que quem está pedindo controla a passkey daquela conta. Autorização on-chain
// continua sendo o __check_auth do contrato.
import { createHash, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

export interface AssertionInput {
  /** authenticatorData em base64url. */
  authenticatorData: string;
  /** clientDataJSON em base64url. */
  clientDataJSON: string;
  /** Assinatura DER em base64url. */
  signature: string;
  /** Chave pública crua de 65 bytes (0x04 || x || y). */
  publicKeyRaw: Buffer;
  /** Nonce emitido em /authn/challenge. */
  expectedChallenge: Buffer;
  expectedOrigins: string[];
  expectedRpId: string;
}

export interface AssertionResult {
  ok: boolean;
  reason?: string;
  signCount?: number;
}

const b64url = (v: string): Buffer => Buffer.from(v, 'base64url');

function publicKeyFromRaw(raw: Buffer) {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('chave pública deve ter 65 bytes não comprimidos (0x04 || x || y)');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

export function verifyAssertion(input: AssertionInput): AssertionResult {
  let clientData: { type?: string; challenge?: string; origin?: string };
  const clientDataBytes = b64url(input.clientDataJSON);
  try {
    clientData = JSON.parse(clientDataBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'clientDataJSON inválido' };
  }

  if (clientData.type !== 'webauthn.get') {
    return { ok: false, reason: `type inesperado: ${clientData.type}` };
  }

  if (!clientData.origin || !input.expectedOrigins.includes(clientData.origin)) {
    return { ok: false, reason: `origem não permitida: ${clientData.origin}` };
  }

  const gotChallenge = b64url(clientData.challenge ?? '');
  if (
    gotChallenge.length !== input.expectedChallenge.length ||
    !timingSafeEqual(gotChallenge, input.expectedChallenge)
  ) {
    return { ok: false, reason: 'challenge não confere' };
  }

  const authData = b64url(input.authenticatorData);
  if (authData.length < 37) return { ok: false, reason: 'authenticatorData curto demais' };

  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = createHash('sha256').update(input.expectedRpId).digest();
  if (!timingSafeEqual(rpIdHash, expectedRpIdHash)) {
    return { ok: false, reason: 'rpIdHash não confere' };
  }

  const flags = authData[32]!;
  if ((flags & 0x01) === 0) return { ok: false, reason: 'user presence não sinalizado' };

  const signCount = authData.readUInt32BE(33);

  // A assinatura cobre authenticatorData || sha256(clientDataJSON).
  const signedData = Buffer.concat([
    authData,
    createHash('sha256').update(clientDataBytes).digest(),
  ]);

  try {
    const verifier = createVerify('sha256');
    verifier.update(signedData);
    verifier.end();
    const valid = verifier.verify(publicKeyFromRaw(input.publicKeyRaw), b64url(input.signature));
    return valid ? { ok: true, signCount } : { ok: false, reason: 'assinatura inválida' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Emissão de EmailAttestation compatível com o contrato
// contracts/email-attestation-verifier.
//
// Encoding: o contrato faz `EmailAttestation::from_xdr`, que espera um ScVal
// map com as chaves em ordem alfabética (challenge, expires_at, signature,
// subject_hash). A mensagem assinada é
// sha256(DOMAIN_SEPARATOR || subject_hash || challenge || expires_at_be).
import { Keypair, hash, xdr } from '@stellar/stellar-sdk';

export const DOMAIN_SEPARATOR = Buffer.from('abstraction-email-attest-v1:');

/** Compromisso com o email: sha256("<salt>:<email normalizado>"). */
export function subjectHash(email: string, salt: string): Buffer {
  return hash(Buffer.from(`${salt}:${email.trim().toLowerCase()}`));
}

/**
 * key_data do signer registrado na smart account:
 * issuer pubkey (32) || subject_hash (32).
 */
export function keyDataFor(issuer: Keypair, subject: Buffer): Buffer {
  return Buffer.concat([issuer.rawPublicKey(), subject]);
}

export function attestationMessage(
  subject: Buffer,
  challenge: Buffer,
  expiresAt: bigint,
): Buffer {
  const exp = Buffer.alloc(8);
  exp.writeBigUInt64BE(expiresAt);
  return hash(Buffer.concat([DOMAIN_SEPARATOR, subject, challenge, exp]));
}

/**
 * Assina e codifica a attestation como ScVal XDR (o `sig_data` que o cliente
 * coloca no AuthPayload).
 */
export function buildAttestationXdr(
  issuer: Keypair,
  subject: Buffer,
  challenge: Buffer,
  expiresAt: bigint,
): Buffer {
  if (challenge.length !== 32) {
    throw new Error('challenge deve ter 32 bytes (auth digest)');
  }
  const signature = issuer.sign(attestationMessage(subject, challenge, expiresAt));

  const entry = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

  // Ordem alfabética obrigatória (validada pelo host no from_xdr).
  const scval = xdr.ScVal.scvMap([
    entry('challenge', xdr.ScVal.scvBytes(challenge)),
    entry('expires_at', xdr.ScVal.scvU64(xdr.Uint64.fromString(expiresAt.toString()))),
    entry('signature', xdr.ScVal.scvBytes(signature)),
    entry('subject_hash', xdr.ScVal.scvBytes(subject)),
  ]);
  return scval.toXDR();
}

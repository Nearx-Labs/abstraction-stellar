// Instância única do smart-account-kit + a cerimônia de login do painel.
//
// Duas passkeys? Não: é a mesma. O kit usa a passkey para assinar auth entries
// de Soroban; aqui, para provar ao painel quem é o dono, fazemos uma assertion
// WebAuthn comum com o mesmo rpId. São usos diferentes da mesma credencial.
import { IndexedDBStorage, SmartAccountKit } from 'smart-account-kit';
import { APP_NAME, CONFIG } from './config';
import { endpoints } from './api';

export const kit = new SmartAccountKit({
  rpcUrl: CONFIG.rpcUrl,
  networkPassphrase: CONFIG.networkPassphrase,
  accountWasmHash: CONFIG.accountWasmHash,
  webauthnVerifierAddress: CONFIG.webauthnVerifierAddress,
  ed25519VerifierAddress: CONFIG.ed25519VerifierAddress,
  relayerUrl: CONFIG.relayerUrl,
  rpName: APP_NAME,
  storage: new IndexedDBStorage(),
});

const toBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/**
 * Abre a sessão do painel: pede um nonce ao back, assina com a passkey e
 * troca a assertion por um cookie httpOnly.
 */
export async function openPanelSession(contractId: string): Promise<void> {
  const { challenge, rpId, allowCredentials } = await endpoints.challenge(contractId);

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(challenge) as BufferSource,
      rpId,
      userVerification: 'preferred',
      allowCredentials: allowCredentials.map((credential) => ({
        id: fromBase64Url(credential.id) as BufferSource,
        type: 'public-key' as const,
      })),
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error('a passkey não respondeu');
  const response = assertion.response as AuthenticatorAssertionResponse;

  await endpoints.verify({
    credentialId: assertion.id,
    authenticatorData: toBase64Url(response.authenticatorData),
    clientDataJSON: toBase64Url(response.clientDataJSON),
    signature: toBase64Url(response.signature),
    challenge,
  });
}

export interface CreatedWallet {
  contractId: string;
  credentialId?: string;
  publicKeyHex?: string;
}

/** Normaliza o retorno do kit — o formato da chave pública varia por browser. */
export function normalizeCreated(result: Record<string, unknown>): CreatedWallet {
  const contractId = String(result.contractId ?? '');
  const credentialId =
    typeof result.credentialId === 'string' ? result.credentialId : undefined;

  const rawKey = result.publicKey;
  let publicKeyHex: string | undefined;
  if (typeof rawKey === 'string') {
    publicKeyHex = rawKey.replace(/^0x/, '');
  } else if (rawKey instanceof Uint8Array) {
    publicKeyHex = Array.from(rawKey)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  return { contractId, credentialId, publicKeyHex };
}

// Ponte para os helpers de auth-payload do smart-account-kit.
//
// Estes helpers constroem o `AuthPayload` que o `__check_auth` da smart account
// espera — encoding consensus-critical, com ordenação de ScMap seguindo a regra
// do host. Reimplementar isso aqui significaria manter uma segunda cópia de
// ~300 linhas que, ao divergir, só falharia quando o contrato recusasse a
// transação em produção.
//
// O kit não os reexporta na raiz e o `exports` do package bloqueia import
// profundo. É uma dependência de caminho privado assumida de propósito: a
// versão está fixada e existe um teste (test/kit-internals.test.ts) que falha
// se o caminho ou os exports sumirem num upgrade — em vez de descobrirmos em
// runtime, quando o contrato recusar a transação.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { xdr } from '@stellar/stellar-sdk';

// Localizar o pacote é mais chato do que parece: o `exports` do kit publica só
// a raiz e bloqueia até `./package.json`, então `require.resolve` não chega nos
// módulos internos; e `import.meta.resolve` some na transformação SSR do
// vitest. Sobra procurar no disco, subindo a partir daqui — cobre tanto
// node_modules local quanto hoisted.
const CANDIDATES = ['../..', '../../..', '../../../..', '../../../../..'];

function findDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of CANDIDATES) {
    const candidate = resolve(here, up, 'node_modules/smart-account-kit/dist');
    if (existsSync(`${candidate}/kit/auth-payload.js`)) return candidate;
  }
  throw new Error(
    'não encontrei smart-account-kit/dist/kit/auth-payload.js — o layout do ' +
      'pacote mudou? Ver test/kit-internals.test.ts.',
  );
}

const distDir = findDist();

const load = <T>(relative: string): Promise<T> =>
  import(pathToFileURL(`${distDir}/${relative}`).href) as Promise<T>;

export interface AuthPayloadHelpers {
  buildSignaturePayload(
    networkPassphrase: string,
    entry: xdr.SorobanAuthorizationEntry,
    expiration: number,
  ): Buffer;
  buildAuthDigest(signaturePayload: Buffer, contextRuleIds: number[]): Buffer;
  buildAddressSignatureScVal(publicKey: Uint8Array, signature: Uint8Array): xdr.ScVal;
  getAddressCredentials(credentials: xdr.SorobanCredentials): {
    address(): xdr.ScAddress;
    signature(value?: xdr.ScVal): xdr.ScVal;
    signatureExpirationLedger(value?: number): number;
  };
  getAuthEntryAddress(entry: xdr.SorobanAuthorizationEntry): string;
  signerToScVal(signer: { tag: string; values: unknown[] }): xdr.ScVal;
  readAuthPayload(signature: xdr.ScVal): {
    context_rule_ids: number[];
    signers: Map<unknown, Buffer>;
  };
  compareScVal(a: xdr.ScVal, b: xdr.ScVal): number;
}

export const authPayload = await load<AuthPayloadHelpers>('kit/auth-payload.js');

/** Nomes que precisam existir; o teste de guarda confere esta lista. */
export const REQUIRED_EXPORTS = [
  'buildSignaturePayload',
  'buildAuthDigest',
  'buildAddressSignatureScVal',
  'getAddressCredentials',
  'getAuthEntryAddress',
  'signerToScVal',
  'readAuthPayload',
  'compareScVal',
] as const;

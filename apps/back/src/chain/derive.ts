// Derivação de contract address a partir do preimage.
//
// Reimplementado aqui (12 linhas) em vez de importar do smart-account-kit: o
// kit é um SDK de browser (WebAuthn + IndexedDB) e não tem por que ser
// dependência do back.
import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE } from './rpc.js';

/**
 * Endereço do contrato que um `ContractIdPreimage` vai produzir.
 *
 * É o que torna um deploy mensurável: a host function `createContract(V2)` não
 * tem alvo invocado nem credencial `Address` nas auth entries, então sem isso o
 * relay não sabia a quem cobrar a taxa mais cara do produto.
 */
export function contractAddressFromPreimage(preimage: xdr.ContractIdPreimage): string {
  const full = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
      contractIdPreimage: preimage,
    }),
  );
  return StrKey.encodeContract(hash(full.toXDR()));
}

/** Mesmo cálculo do kit, para conferir um contractId reportado pelo cliente. */
export function deriveContractAddress(
  credentialId: Buffer,
  deployerPublicKey: string,
): string {
  return contractAddressFromPreimage(
    xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: Address.fromString(deployerPublicKey).toScAddress(),
        salt: hash(credentialId),
      }),
    ),
  );
}

// Gera o vetor de teste cross-language consumido por
// contracts/email-attestation-verifier/fixtures/js_attestation_vector.txt.
//
// Os valores espelham os testes Rust: issuer seed [42;32], subject [1;32],
// challenge [2;32], expiração NOW+300 com NOW=1_800_000_000.
import { Keypair } from '@stellar/stellar-sdk';
import { buildAttestationXdr, keyDataFor } from './attestation.js';

const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
const subject = Buffer.alloc(32, 1);
const challenge = Buffer.alloc(32, 2);
const expiresAt = 1_800_000_300n;

const keyData = keyDataFor(issuer, subject);
const sigData = buildAttestationXdr(issuer, subject, challenge, expiresAt);

// Formato: linhas key=value, consumidas por include_str! no teste Rust.
process.stdout.write(
  [
    `key_data=${keyData.toString('hex')}`,
    `sig_data=${sigData.toString('hex')}`,
    `payload=${challenge.toString('hex')}`,
    `timestamp=${(expiresAt - 300n).toString()}`,
    '',
  ].join('\n'),
);

//! # Ed25519 Verifier Contract
//!
//! Reusable verifier contract for Ed25519 signature verification. Deployed
//! once and shared by any MetaAccount that registers an Ed25519 external
//! signer (relayer/admin fallback keys, dev tooling).
use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{ed25519, Verifier};

#[contract]
pub struct Ed25519VerifierContract;

#[contractimpl]
impl Verifier for Ed25519VerifierContract {
    type KeyData = BytesN<32>;
    type SigData = BytesN<64>;

    /// Verify an Ed25519 signature over `signature_payload` (the smart
    /// account auth digest) against a 32-byte public key.
    fn verify(
        e: &Env,
        signature_payload: Bytes,
        key_data: BytesN<32>,
        sig_data: BytesN<64>,
    ) -> bool {
        ed25519::verify(e, &signature_payload, &key_data, &sig_data)
    }

    /// Canonical identity of an Ed25519 key is the key itself.
    fn canonicalize_key(e: &Env, key_data: BytesN<32>) -> Bytes {
        ed25519::canonicalize_key(e, &key_data)
    }

    fn batch_canonicalize_key(e: &Env, keys_data: Vec<BytesN<32>>) -> Vec<Bytes> {
        ed25519::batch_canonicalize_key(e, &keys_data)
    }
}

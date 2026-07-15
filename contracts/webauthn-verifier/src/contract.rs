//! # WebAuthn (Passkey) Verifier Contract
//!
//! Reusable verifier contract for WebAuthn assertion verification
//! (secp256r1/P-256). Deployed once and shared by every MetaAccount that
//! registers a passkey signer.
//!
//! * `key_data`: 65-byte uncompressed secp256r1 public key followed by the
//!   credential ID bytes (variable length, used only client-side).
//! * `sig_data`: XDR-encoded [`WebAuthnSigData`] (signature, authenticator
//!   data, client data JSON). The verifier checks the challenge in the client
//!   data JSON against the base64url-encoded signature payload, the UP/UV
//!   flags in the authenticator data, and the secp256r1 signature itself.
use soroban_sdk::{contract, contractimpl, xdr::FromXdr, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{
    utils::extract_from_bytes,
    webauthn::{self, WebAuthnSigData},
    Verifier,
};

#[contract]
pub struct WebauthnVerifierContract;

#[contractimpl]
impl Verifier for WebauthnVerifierContract {
    type KeyData = Bytes;
    type SigData = Bytes;

    fn verify(
        e: &Env,
        signature_payload: Bytes,
        key_data: Self::KeyData,
        sig_data: Self::SigData,
    ) -> bool {
        let sig_struct =
            WebAuthnSigData::from_xdr(e, &sig_data).expect("WebAuthnSigData with correct format");

        let pub_key: BytesN<65> =
            extract_from_bytes(e, &key_data, 0..65).expect("65-byte public key to be extracted");

        webauthn::verify(e, &signature_payload, &pub_key, &sig_struct)
    }

    /// Canonical identity is the 65-byte public key, stripping the
    /// variable-length credential ID suffix.
    fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes {
        webauthn::canonicalize_key(e, &key_data)
    }

    fn batch_canonicalize_key(e: &Env, keys_data: Vec<Bytes>) -> Vec<Bytes> {
        webauthn::batch_canonicalize_key(e, &keys_data)
    }
}

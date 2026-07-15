//! # Email Attestation Verifier Contract
//!
//! Verificador reutilizável para login por email como authenticator de smart
//! accounts, sem validar JWT bruto on-chain. Um Auth Service off-chain
//! confiável valida o email do usuário (OTP/magic link) e emite uma
//! attestation curta assinada com sua chave Ed25519; este contrato verifica
//! apenas essa assinatura e seus vínculos.
//!
//! ## Modelo de confiança e anti-replay
//!
//! * `key_data` (armazenado na conta ao registrar o signer):
//!   32 bytes da chave pública Ed25519 do issuer || 32 bytes do
//!   `subject_hash` (compromisso com o email, ex.: sha256(email normalizado
//!   + salt do issuer)). Trocar de issuer ou de email é registrar outro
//!   signer.
//! * `sig_data`: XDR de [`EmailAttestation`].
//! * O `challenge` da attestation precisa ser exatamente o
//!   `signature_payload` recebido (o auth digest da smart account, que o
//!   host deriva de nonce/expiração/invocações da transação). Replay em
//!   outra transação, rede ou seleção de regras muda o digest e invalida a
//!   attestation — a proteção anti-replay do protocolo é herdada, sem mapa
//!   de nonces próprio.
//! * `expires_at` (unix, segundos) limita a janela da attestation; o issuer
//!   deve emitir TTLs curtos (minutos).
//!
//! A mensagem assinada pelo issuer é
//! `sha256(DOMAIN_SEPARATOR || subject_hash || challenge || expires_at_be)`,
//! com domain separator para impedir reuso da chave do issuer em outros
//! protocolos.
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, xdr::FromXdr, Bytes,
    BytesN, Env, Vec,
};
use stellar_accounts::verifiers::{utils::extract_from_bytes, Verifier};

/// Prefixo de domínio da mensagem assinada pelo issuer.
pub const DOMAIN_SEPARATOR: &[u8; 28] = b"abstraction-email-attest-v1:";

/// Tamanho esperado do `key_data`: issuer pubkey (32) + subject hash (32).
pub const KEY_DATA_LEN: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EmailAttestationError {
    /// `sig_data` não decodifica para um `EmailAttestation` válido.
    AttestationFormatInvalid = 3210,
    /// `key_data` não tem os 64 bytes esperados (pubkey + subject hash).
    KeyDataInvalid = 3211,
    /// O payload de assinatura não tem 32 bytes.
    SignaturePayloadInvalid = 3212,
}

/// Attestation emitida pelo Auth Service após verificação do email.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EmailAttestation {
    /// Compromisso com o email verificado; precisa bater com o registrado
    /// no `key_data` do signer.
    pub subject_hash: BytesN<32>,
    /// Auth digest da transação sendo autorizada (vínculo anti-replay).
    pub challenge: BytesN<32>,
    /// Expiração em unix time (segundos).
    pub expires_at: u64,
    /// Assinatura Ed25519 do issuer sobre [`attestation_message`].
    pub signature: BytesN<64>,
}

/// Constrói a mensagem que o issuer assina:
/// `sha256(DOMAIN_SEPARATOR || subject_hash || challenge || expires_at_be)`.
pub fn attestation_message(
    e: &Env,
    subject_hash: &BytesN<32>,
    challenge: &BytesN<32>,
    expires_at: u64,
) -> Bytes {
    let mut msg = Bytes::from_slice(e, DOMAIN_SEPARATOR);
    msg.append(&subject_hash.to_bytes().into());
    msg.append(&challenge.to_bytes().into());
    msg.extend_from_array(&expires_at.to_be_bytes());
    e.crypto().sha256(&msg).to_bytes().into()
}

#[contract]
pub struct EmailAttestationVerifierContract;

#[contractimpl]
impl Verifier for EmailAttestationVerifierContract {
    type KeyData = Bytes;
    type SigData = Bytes;

    /// Verifica uma attestation de email contra o auth digest da conta.
    ///
    /// Retorna `false` para mismatches semânticos (subject errado,
    /// challenge diferente, attestation expirada) e panica para entradas
    /// malformadas ou assinatura Ed25519 inválida.
    fn verify(
        e: &Env,
        signature_payload: Bytes,
        key_data: Self::KeyData,
        sig_data: Self::SigData,
    ) -> bool {
        let attestation = EmailAttestation::from_xdr(e, &sig_data)
            .unwrap_or_else(|_| panic_with_error!(e, EmailAttestationError::AttestationFormatInvalid));

        if key_data.len() != KEY_DATA_LEN {
            panic_with_error!(e, EmailAttestationError::KeyDataInvalid);
        }
        let issuer_pk: BytesN<32> = extract_from_bytes(e, &key_data, 0..32)
            .unwrap_or_else(|| panic_with_error!(e, EmailAttestationError::KeyDataInvalid));
        let subject_hash: BytesN<32> = extract_from_bytes(e, &key_data, 32..64)
            .unwrap_or_else(|| panic_with_error!(e, EmailAttestationError::KeyDataInvalid));

        let payload: BytesN<32> = extract_from_bytes(e, &signature_payload, ..)
            .unwrap_or_else(|| panic_with_error!(e, EmailAttestationError::SignaturePayloadInvalid));

        if attestation.subject_hash != subject_hash {
            return false;
        }
        if attestation.challenge != payload {
            return false;
        }
        if e.ledger().timestamp() > attestation.expires_at {
            return false;
        }

        let message =
            attestation_message(e, &attestation.subject_hash, &attestation.challenge, attestation.expires_at);
        // Panica se a assinatura for inválida.
        e.crypto().ed25519_verify(&issuer_pk, &message, &attestation.signature);

        true
    }

    /// Identidade canônica: os 64 bytes completos (issuer + subject) — o
    /// mesmo email atestado por issuers diferentes são signers distintos.
    fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes {
        if key_data.len() != KEY_DATA_LEN {
            panic_with_error!(e, EmailAttestationError::KeyDataInvalid);
        }
        key_data
    }

    fn batch_canonicalize_key(e: &Env, keys_data: Vec<Bytes>) -> Vec<Bytes> {
        Vec::from_iter(e, keys_data.iter().map(|k| Self::canonicalize_key(e, k)))
    }
}

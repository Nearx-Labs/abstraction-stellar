extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    testutils::{Ledger as _},
    xdr::ToXdr,
    Bytes, BytesN, Env,
};

use crate::contract::{
    attestation_message, EmailAttestation, EmailAttestationVerifierContract,
    EmailAttestationVerifierContractClient,
};

const NOW: u64 = 1_800_000_000;

fn setup(e: &Env) -> EmailAttestationVerifierContractClient<'_> {
    e.ledger().with_mut(|l| l.timestamp = NOW);
    let contract_id = e.register(EmailAttestationVerifierContract, ());
    EmailAttestationVerifierContractClient::new(e, &contract_id)
}

fn issuer_key() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32])
}

fn make_attestation(
    e: &Env,
    issuer: &SigningKey,
    subject_hash: &BytesN<32>,
    challenge: &BytesN<32>,
    expires_at: u64,
) -> EmailAttestation {
    let message = attestation_message(e, subject_hash, challenge, expires_at);
    let mut msg_buf = std::vec![0u8; message.len() as usize];
    message.copy_into_slice(&mut msg_buf);
    let signature = issuer.sign(&msg_buf);

    EmailAttestation {
        subject_hash: subject_hash.clone(),
        challenge: challenge.clone(),
        expires_at,
        signature: BytesN::from_array(e, &signature.to_bytes()),
    }
}

fn key_data(e: &Env, issuer: &SigningKey, subject_hash: &BytesN<32>) -> Bytes {
    let mut kd = Bytes::from_array(e, &issuer.verifying_key().to_bytes());
    kd.append(&subject_hash.to_bytes().into());
    kd
}

#[test]
fn verify_success() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);
    let attestation = make_attestation(&e, &issuer, &subject, &challenge, NOW + 300);

    let payload = Bytes::from_array(&e, &challenge.to_array());
    assert!(client.verify(&payload, &key_data(&e, &issuer, &subject), &attestation.to_xdr(&e)));
}

#[test]
fn verify_wrong_subject_fails() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let other_subject = BytesN::from_array(&e, &[9u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);
    let attestation = make_attestation(&e, &issuer, &subject, &challenge, NOW + 300);

    let payload = Bytes::from_array(&e, &challenge.to_array());
    assert!(!client.verify(
        &payload,
        &key_data(&e, &issuer, &other_subject),
        &attestation.to_xdr(&e)
    ));
}

#[test]
fn verify_wrong_challenge_fails() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);
    let attestation = make_attestation(&e, &issuer, &subject, &challenge, NOW + 300);

    // Digest de outra transação.
    let payload = Bytes::from_array(&e, &[3u8; 32]);
    assert!(!client.verify(&payload, &key_data(&e, &issuer, &subject), &attestation.to_xdr(&e)));
}

#[test]
fn verify_expired_fails() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);
    let attestation = make_attestation(&e, &issuer, &subject, &challenge, NOW - 1);

    let payload = Bytes::from_array(&e, &challenge.to_array());
    assert!(!client.verify(&payload, &key_data(&e, &issuer, &subject), &attestation.to_xdr(&e)));
}

/// Vetor gerado pelo serviço JS (services/auth-issuer, `npm run fixture`) —
/// garante que o encoding ScVal/assinatura do issuer em TypeScript é
/// exatamente o que o contrato espera.
#[test]
fn verify_js_generated_attestation() {
    let e = Env::default();
    let client = setup(&e);

    let vector = include_str!("../fixtures/js_attestation_vector.txt");
    let mut key_data_hex = "";
    let mut sig_data_hex = "";
    let mut payload_hex = "";
    let mut timestamp = 0u64;
    for line in vector.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k {
                "key_data" => key_data_hex = v,
                "sig_data" => sig_data_hex = v,
                "payload" => payload_hex = v,
                "timestamp" => timestamp = v.parse().unwrap(),
                _ => {}
            }
        }
    }

    fn hex_to_bytes(e: &Env, s: &str) -> Bytes {
        let raw: std::vec::Vec<u8> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        Bytes::from_slice(e, &raw)
    }

    e.ledger().with_mut(|l| l.timestamp = timestamp);
    assert!(client.verify(
        &hex_to_bytes(&e, payload_hex),
        &hex_to_bytes(&e, key_data_hex),
        &hex_to_bytes(&e, sig_data_hex),
    ));
}

#[test]
#[should_panic(expected = "Error(Crypto, InvalidInput)")]
fn verify_forged_signature_panics() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();
    let forger = SigningKey::from_bytes(&[43u8; 32]);

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);
    // Attestation assinada por outra chave que não a registrada.
    let attestation = make_attestation(&e, &forger, &subject, &challenge, NOW + 300);

    let payload = Bytes::from_array(&e, &challenge.to_array());
    client.verify(&payload, &key_data(&e, &issuer, &subject), &attestation.to_xdr(&e));
}

#[test]
#[should_panic(expected = "Error(Contract, #3211)")]
fn verify_bad_key_data_panics() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);
    let attestation = make_attestation(&e, &issuer, &subject, &challenge, NOW + 300);

    let payload = Bytes::from_array(&e, &challenge.to_array());
    let short_key = Bytes::from_array(&e, &[0u8; 32]);
    client.verify(&payload, &short_key, &attestation.to_xdr(&e));
}

#[test]
// O decode XDR malformado trap no host antes do erro tipado do contrato.
#[should_panic(expected = "Error(Value, InvalidInput)")]
fn verify_bad_sig_data_panics() {
    let e = Env::default();
    let client = setup(&e);
    let issuer = issuer_key();

    let subject = BytesN::from_array(&e, &[1u8; 32]);
    let challenge = BytesN::from_array(&e, &[2u8; 32]);

    let payload = Bytes::from_array(&e, &challenge.to_array());
    let garbage = Bytes::from_array(&e, &[7u8; 10]);
    client.verify(&payload, &key_data(&e, &issuer, &subject), &garbage);
}

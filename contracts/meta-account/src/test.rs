extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use ed25519_verifier::Ed25519VerifierContract;
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, map, symbol_short,
    testutils::{Address as _, BytesN as _},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Map, TryFromVal, Val, Vec,
};
use stellar_accounts::smart_account::{AuthPayload, Signer, SmartAccountError};

use crate::contract::{MetaAccount, MetaAccountClient};

#[contract]
struct MockVerifierContract;

#[contractimpl]
impl MockVerifierContract {
    pub fn verify(_e: &Env, _hash: Bytes, _key_data: Val, _sig_data: Val) -> bool {
        true
    }

    pub fn canonicalize_key(e: &Env, key_data: Val) -> Bytes {
        Bytes::try_from_val(e, &key_data).unwrap()
    }

    pub fn batch_canonicalize_key(e: &Env, key_data: Vec<Val>) -> Vec<Bytes> {
        Vec::from_iter(e, key_data.iter().map(|key| Bytes::try_from_val(e, &key).unwrap()))
    }
}

fn ed25519_signer(e: &Env, verifier: &Address, seed: u8) -> (Signer, SigningKey) {
    let signing_key = SigningKey::from_bytes(&[seed; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let signer = Signer::External(verifier.clone(), Bytes::from_array(e, &public_key));
    (signer, signing_key)
}

/// Assina o digest que `do_check_auth` reconstrói:
/// `sha256(signature_payload || context_rule_ids.to_xdr())`.
fn sign_auth_digest(
    e: &Env,
    signing_key: &SigningKey,
    signature_payload: &BytesN<32>,
    context_rule_ids: &Vec<u32>,
) -> Bytes {
    let mut preimage = Bytes::from_array(e, &signature_payload.to_array());
    preimage.append(&context_rule_ids.clone().to_xdr(e));
    let digest = e.crypto().sha256(&preimage);
    let signature = signing_key.sign(&digest.to_array());
    Bytes::from_array(e, &signature.to_bytes())
}

#[test]
fn create_account_with_external_signer() {
    let e = Env::default();
    let verifier = e.register(MockVerifierContract, ());
    let signers = vec![
        &e,
        Signer::External(verifier.clone(), Bytes::from_array(&e, &[1u8; 32])),
        Signer::External(verifier.clone(), Bytes::from_array(&e, &[2u8; 32])),
    ];
    let account = e.register(MetaAccount, (signers, Map::<Address, Val>::new(&e)));

    let client = MetaAccountClient::new(&e, &account);
    let rule = client.get_context_rule(&0);
    assert_eq!(rule.signers.len(), 2);
    assert_eq!(client.get_context_rules_count(), 1);
}

#[test]
fn batch_add_signer_adds_all_signers() {
    let e = Env::default();
    e.mock_all_auths();

    let verifier = e.register(MockVerifierContract, ());
    let initial_signer = Signer::External(verifier.clone(), Bytes::from_array(&e, &[1u8; 32]));
    let account = e.register(
        MetaAccount,
        (vec![&e, initial_signer.clone()], Map::<Address, Val>::new(&e)),
    );

    let new_signer_1 = Signer::External(verifier.clone(), Bytes::from_array(&e, &[2u8; 32]));
    let new_signer_2 = Signer::External(verifier.clone(), Bytes::from_array(&e, &[3u8; 32]));

    let client = MetaAccountClient::new(&e, &account);
    client.batch_add_signer(&0, &vec![&e, new_signer_1.clone(), new_signer_2.clone()]);

    let rule = client.get_context_rule(&0);
    assert_eq!(rule.signers.len(), 3);
    assert!(rule.signers.contains(&initial_signer));
    assert!(rule.signers.contains(&new_signer_1));
    assert!(rule.signers.contains(&new_signer_2));
}

#[test]
fn check_auth_with_real_ed25519_signature_succeeds() {
    let e = Env::default();
    let verifier = e.register(Ed25519VerifierContract, ());
    let (signer, signing_key) = ed25519_signer(&e, &verifier, 7);

    let account =
        e.register(MetaAccount, (vec![&e, signer.clone()], Map::<Address, Val>::new(&e)));

    let signature_payload = BytesN::<32>::random(&e);
    let context_rule_ids = vec![&e, 0u32];
    let sig = sign_auth_digest(&e, &signing_key, &signature_payload, &context_rule_ids);

    let auth_payload = AuthPayload {
        signers: map![&e, (signer, sig)],
        context_rule_ids,
    };
    let auth_contexts = vec![
        &e,
        Context::Contract(ContractContext {
            contract: Address::generate(&e),
            fn_name: symbol_short!("transfer"),
            args: vec![&e],
        }),
    ];

    let result = e.try_invoke_contract_check_auth::<SmartAccountError>(
        &account,
        &signature_payload,
        auth_payload.into_val(&e),
        &auth_contexts,
    );
    assert!(result.is_ok());
}

#[test]
fn check_auth_with_tampered_signature_fails() {
    let e = Env::default();
    let verifier = e.register(Ed25519VerifierContract, ());
    let (signer, signing_key) = ed25519_signer(&e, &verifier, 7);

    let account =
        e.register(MetaAccount, (vec![&e, signer.clone()], Map::<Address, Val>::new(&e)));

    let signature_payload = BytesN::<32>::random(&e);
    let context_rule_ids = vec![&e, 0u32];
    // Assina um payload diferente do que o host apresenta.
    let other_payload = BytesN::<32>::random(&e);
    let sig = sign_auth_digest(&e, &signing_key, &other_payload, &context_rule_ids);

    let auth_payload = AuthPayload {
        signers: map![&e, (signer, sig)],
        context_rule_ids,
    };
    let auth_contexts = vec![
        &e,
        Context::Contract(ContractContext {
            contract: Address::generate(&e),
            fn_name: symbol_short!("transfer"),
            args: vec![&e],
        }),
    ];

    let result = e.try_invoke_contract_check_auth::<SmartAccountError>(
        &account,
        &signature_payload,
        auth_payload.into_val(&e),
        &auth_contexts,
    );
    assert!(result.is_err());
}

#[test]
fn check_auth_from_unregistered_signer_fails() {
    let e = Env::default();
    let verifier = e.register(Ed25519VerifierContract, ());
    let (signer, _) = ed25519_signer(&e, &verifier, 7);
    let (intruder, intruder_key) = ed25519_signer(&e, &verifier, 9);

    let account = e.register(MetaAccount, (vec![&e, signer], Map::<Address, Val>::new(&e)));

    let signature_payload = BytesN::<32>::random(&e);
    let context_rule_ids = vec![&e, 0u32];
    let sig = sign_auth_digest(&e, &intruder_key, &signature_payload, &context_rule_ids);

    let auth_payload = AuthPayload {
        signers: map![&e, (intruder, sig)],
        context_rule_ids,
    };
    let auth_contexts = vec![
        &e,
        Context::Contract(ContractContext {
            contract: Address::generate(&e),
            fn_name: symbol_short!("transfer"),
            args: vec![&e],
        }),
    ];

    let result = e.try_invoke_contract_check_auth::<SmartAccountError>(
        &account,
        &signature_payload,
        auth_payload.into_val(&e),
        &auth_contexts,
    );
    assert!(result.is_err());
}

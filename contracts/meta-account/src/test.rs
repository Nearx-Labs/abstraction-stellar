extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use ed25519_verifier::Ed25519VerifierContract;
use email_attestation_verifier::{
    attestation_message, EmailAttestation, EmailAttestationVerifierContract,
};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, map, symbol_short,
    testutils::{Address as _, BytesN as _, Ledger as _},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Map, String, TryFromVal, Val, Vec,
};
use spending_limit_policy::SpendingLimitPolicyContract;
use stellar_accounts::policies::spending_limit::SpendingLimitAccountParams;
use stellar_accounts::smart_account::{AuthPayload, ContextRuleType, Signer, SmartAccountError};

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

// ---------------------------------------------------------------------------
// Fase 2: email attestation como authenticator em regra CallContract separada
// ---------------------------------------------------------------------------

const NOW: u64 = 1_800_000_000;

/// Digest que o issuer usa como challenge:
/// `sha256(signature_payload || context_rule_ids.to_xdr())`.
fn auth_digest(e: &Env, signature_payload: &BytesN<32>, context_rule_ids: &Vec<u32>) -> BytesN<32> {
    let mut preimage = Bytes::from_array(e, &signature_payload.to_array());
    preimage.append(&context_rule_ids.clone().to_xdr(e));
    e.crypto().sha256(&preimage).to_bytes()
}

fn email_key_data(e: &Env, issuer: &SigningKey, subject_hash: &BytesN<32>) -> Bytes {
    let mut kd = Bytes::from_array(e, &issuer.verifying_key().to_bytes());
    kd.append(&subject_hash.to_bytes().into());
    kd
}

fn issue_attestation(
    e: &Env,
    issuer: &SigningKey,
    subject_hash: &BytesN<32>,
    challenge: &BytesN<32>,
    expires_at: u64,
) -> Bytes {
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
    .to_xdr(e)
}

struct EmailSetup {
    account: Address,
    target: Address,
    email_signer: Signer,
    issuer: SigningKey,
    subject_hash: BytesN<32>,
    email_rule_id: u32,
}

/// Conta com passkey/ed25519 na regra Default (id 0) e um email signer numa
/// regra restrita a `CallContract(target)` (id 1) — email sozinho não
/// administra a conta.
fn setup_email_account(e: &Env) -> EmailSetup {
    e.ledger().with_mut(|l| l.timestamp = NOW);
    e.mock_all_auths();

    let ed_verifier = e.register(Ed25519VerifierContract, ());
    let email_verifier = e.register(EmailAttestationVerifierContract, ());

    let (primary_signer, _) = ed25519_signer(e, &ed_verifier, 7);
    let account =
        e.register(MetaAccount, (vec![e, primary_signer], Map::<Address, Val>::new(e)));

    let issuer = SigningKey::from_bytes(&[42u8; 32]);
    let subject_hash = BytesN::from_array(e, &[11u8; 32]);
    let email_signer =
        Signer::External(email_verifier, email_key_data(e, &issuer, &subject_hash));

    let target = Address::generate(e);
    let client = MetaAccountClient::new(e, &account);
    let rule = client.add_context_rule(
        &ContextRuleType::CallContract(target.clone()),
        &String::from_str(e, "email"),
        &None,
        &vec![e, email_signer.clone()],
        &Map::new(e),
    );

    EmailSetup { account, target, email_signer, issuer, subject_hash, email_rule_id: rule.id }
}

fn email_auth_result(
    e: &Env,
    setup: &EmailSetup,
    call_target: &Address,
    challenge_payload: &BytesN<32>,
    presented_payload: &BytesN<32>,
    expires_at: u64,
) -> Result<(), Result<SmartAccountError, soroban_sdk::InvokeError>> {
    let context_rule_ids = vec![e, setup.email_rule_id];
    let challenge = auth_digest(e, challenge_payload, &context_rule_ids);
    let attestation =
        issue_attestation(e, &setup.issuer, &setup.subject_hash, &challenge, expires_at);

    let auth_payload = AuthPayload {
        signers: map![e, (setup.email_signer.clone(), attestation)],
        context_rule_ids,
    };
    let auth_contexts = vec![
        e,
        Context::Contract(ContractContext {
            contract: call_target.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![e],
        }),
    ];

    e.try_invoke_contract_check_auth::<SmartAccountError>(
        &setup.account,
        presented_payload,
        auth_payload.into_val(e),
        &auth_contexts,
    )
}

#[test]
fn check_auth_with_email_attestation_succeeds() {
    let e = Env::default();
    let setup = setup_email_account(&e);

    let payload = BytesN::<32>::random(&e);
    let target = setup.target.clone();
    let result = email_auth_result(&e, &setup, &target, &payload, &payload, NOW + 300);
    assert!(result.is_ok());
}

#[test]
fn email_rule_does_not_authorize_other_contract() {
    let e = Env::default();
    let setup = setup_email_account(&e);

    let payload = BytesN::<32>::random(&e);
    let other_contract = Address::generate(&e);
    let result = email_auth_result(&e, &setup, &other_contract, &payload, &payload, NOW + 300);
    assert!(result.is_err());
}

#[test]
fn expired_email_attestation_fails() {
    let e = Env::default();
    let setup = setup_email_account(&e);

    let payload = BytesN::<32>::random(&e);
    let target = setup.target.clone();
    let result = email_auth_result(&e, &setup, &target, &payload, &payload, NOW - 1);
    assert!(result.is_err());
}

#[test]
fn email_attestation_bound_to_other_tx_fails() {
    let e = Env::default();
    let setup = setup_email_account(&e);

    // Attestation emitida para o digest de outra transação.
    let signed_for = BytesN::<32>::random(&e);
    let presented = BytesN::<32>::random(&e);
    let target = setup.target.clone();
    let result = email_auth_result(&e, &setup, &target, &signed_for, &presented, NOW + 300);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Fase 4: session keys — regra CallContract com valid_until + spending limit
// ---------------------------------------------------------------------------

const START_SEQ: u32 = 1_000;
const SESSION_TTL_LEDGERS: u32 = 100;
const SESSION_SPEND_LIMIT: i128 = 500;

struct SessionSetup {
    account: Address,
    target: Address,
    session_signer: Signer,
    session_key: SigningKey,
    rule_id: u32,
}

/// Conta com signer primário na regra Default e uma session key efêmera numa
/// regra `CallContract(target)` com expiração por ledger e spending limit.
fn setup_session_account(e: &Env) -> SessionSetup {
    e.ledger().with_mut(|l| {
        l.timestamp = NOW;
        l.sequence_number = START_SEQ;
        // Sessões expiram por ledger; mantém entradas persistentes vivas.
        l.min_persistent_entry_ttl = 100_000;
        l.max_entry_ttl = 1_000_000;
    });
    e.mock_all_auths();

    let ed_verifier = e.register(Ed25519VerifierContract, ());
    let policy = e.register(SpendingLimitPolicyContract, ());

    let (primary_signer, _) = ed25519_signer(e, &ed_verifier, 7);
    let account =
        e.register(MetaAccount, (vec![e, primary_signer], Map::<Address, Val>::new(e)));

    // Chave efêmera gerada no cliente após login forte com passkey.
    let (session_signer, session_key) = ed25519_signer(e, &ed_verifier, 21);

    let target = Address::generate(e);
    let client = MetaAccountClient::new(e, &account);
    let rule = client.add_context_rule(
        &ContextRuleType::CallContract(target.clone()),
        &String::from_str(e, "session"),
        &Some(START_SEQ + SESSION_TTL_LEDGERS),
        &vec![e, session_signer.clone()],
        &map![
            e,
            (
                policy,
                SpendingLimitAccountParams {
                    spending_limit: SESSION_SPEND_LIMIT,
                    period_ledgers: SESSION_TTL_LEDGERS,
                }
                .into_val(e)
            )
        ],
    );

    SessionSetup { account, target, session_signer, session_key, rule_id: rule.id }
}

/// Tenta autorizar `transfer(account, to, amount)` no alvo com a session key.
fn session_transfer_result(
    e: &Env,
    setup: &SessionSetup,
    call_target: &Address,
    amount: i128,
) -> Result<(), Result<SmartAccountError, soroban_sdk::InvokeError>> {
    let signature_payload = BytesN::<32>::random(e);
    let context_rule_ids = vec![e, setup.rule_id];
    let sig = sign_auth_digest(e, &setup.session_key, &signature_payload, &context_rule_ids);

    let auth_payload = AuthPayload {
        signers: map![e, (setup.session_signer.clone(), sig)],
        context_rule_ids,
    };
    let recipient = Address::generate(e);
    let auth_contexts = vec![
        e,
        Context::Contract(ContractContext {
            contract: call_target.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![
                e,
                setup.account.clone().into_val(e),
                recipient.into_val(e),
                amount.into_val(e),
            ],
        }),
    ];

    e.try_invoke_contract_check_auth::<SmartAccountError>(
        &setup.account,
        &signature_payload,
        auth_payload.into_val(e),
        &auth_contexts,
    )
}

#[test]
fn session_key_authorizes_within_spending_limit() {
    let e = Env::default();
    let setup = setup_session_account(&e);

    let target = setup.target.clone();
    assert!(session_transfer_result(&e, &setup, &target, 300).is_ok());
    assert!(session_transfer_result(&e, &setup, &target, 200).is_ok());
    // 300 + 200 esgotou o limite de 500 na janela.
    assert!(session_transfer_result(&e, &setup, &target, 1).is_err());
}

#[test]
fn session_single_transfer_over_limit_fails() {
    let e = Env::default();
    let setup = setup_session_account(&e);

    let target = setup.target.clone();
    assert!(session_transfer_result(&e, &setup, &target, SESSION_SPEND_LIMIT + 1).is_err());
}

#[test]
fn session_rule_expires_by_ledger() {
    let e = Env::default();
    let setup = setup_session_account(&e);

    let target = setup.target.clone();
    assert!(session_transfer_result(&e, &setup, &target, 10).is_ok());

    // Passou do valid_until: a sessão morre sozinha, sem revogação.
    e.ledger().with_mut(|l| l.sequence_number = START_SEQ + SESSION_TTL_LEDGERS + 1);
    assert!(session_transfer_result(&e, &setup, &target, 10).is_err());
}

#[test]
fn session_rule_can_be_revoked() {
    let e = Env::default();
    let setup = setup_session_account(&e);

    let target = setup.target.clone();
    assert!(session_transfer_result(&e, &setup, &target, 10).is_ok());

    let client = MetaAccountClient::new(&e, &setup.account);
    client.remove_context_rule(&setup.rule_id);
    assert!(session_transfer_result(&e, &setup, &target, 10).is_err());
}

#[test]
fn session_key_cannot_administer_account() {
    let e = Env::default();
    let setup = setup_session_account(&e);

    // Tenta autorizar uma operação administrativa (na própria conta) com a
    // regra de sessão: contexto não bate com CallContract(target).
    let account = setup.account.clone();
    assert!(session_transfer_result(&e, &setup, &account, 10).is_err());
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

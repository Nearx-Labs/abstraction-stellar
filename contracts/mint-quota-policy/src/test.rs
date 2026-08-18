#![cfg(test)]
extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    testutils::{Address as _, Ledger as _},
    Address, Env, IntoVal, String, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType};

use crate::{MintQuotaParams, MintQuotaPolicyContract, MintQuotaPolicyContractClient};

const RULE_ID: u32 = 1;

fn rule(e: &Env, target: &Address) -> ContextRule {
    ContextRule {
        id: RULE_ID,
        context_type: ContextRuleType::CallContract(target.clone()),
        name: String::from_str(e, "mint"),
        valid_until: None,
        signers: Vec::new(e),
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
    }
}

fn mint_context(e: &Env, target: &Address) -> Context {
    Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: Symbol::new(e, "mint"),
        args: Vec::new(e),
    })
}

struct Fixture {
    e: Env,
    client: MintQuotaPolicyContractClient<'static>,
    account: Address,
    target: Address,
}

fn setup(max_items: u32, period_ledgers: u32) -> Fixture {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(MintQuotaPolicyContract, ());
    let client = MintQuotaPolicyContractClient::new(&e, &contract_id);

    let account = Address::generate(&e);
    let target = Address::generate(&e);

    client.install(
        &MintQuotaParams {
            max_items,
            period_ledgers,
        },
        &rule(&e, &target),
        &account,
    );

    Fixture {
        e,
        client,
        account,
        target,
    }
}

fn enforce(f: &Fixture) {
    f.client.enforce(
        &mint_context(&f.e, &f.target),
        &Vec::new(&f.e),
        &rule(&f.e, &f.target),
        &f.account,
    );
}

#[test]
fn allows_calls_up_to_the_cap() {
    let f = setup(3, 1_000);

    for expected in 1..=3u32 {
        enforce(&f);
        let data = f.client.get_quota_data(&RULE_ID, &f.account);
        assert_eq!(data.used, expected);
        assert_eq!(data.max_items, 3);
    }
}

#[test]
#[should_panic(expected = "Error(Contract, #6200)")]
fn rejects_the_call_past_the_cap() {
    let f = setup(2, 1_000);
    enforce(&f);
    enforce(&f);
    // O terceiro é o que o tenant não autorizou.
    enforce(&f);
}

#[test]
fn window_slides_and_frees_the_quota() {
    let f = setup(2, 100);
    f.e.ledger().with_mut(|l| l.sequence_number = 1_000);

    enforce(&f);
    enforce(&f);
    assert_eq!(f.client.get_quota_data(&RULE_ID, &f.account).used, 2);

    // Passada a janela, as chamadas antigas saem da contagem.
    f.e.ledger().with_mut(|l| l.sequence_number = 1_101);
    assert_eq!(f.client.get_quota_data(&RULE_ID, &f.account).used, 0);
    enforce(&f);
    assert_eq!(f.client.get_quota_data(&RULE_ID, &f.account).used, 1);
}

#[test]
fn quota_is_isolated_per_account() {
    let f = setup(1, 1_000);
    let other = Address::generate(&f.e);
    f.client.install(
        &MintQuotaParams {
            max_items: 5,
            period_ledgers: 1_000,
        },
        &rule(&f.e, &f.target),
        &other,
    );

    enforce(&f);
    assert_eq!(f.client.get_quota_data(&RULE_ID, &f.account).used, 1);
    // A cota da outra conta continua intocada — o contrato é multi-tenant.
    assert_eq!(f.client.get_quota_data(&RULE_ID, &other).used, 0);
}

#[test]
fn set_quota_raises_the_cap() {
    let f = setup(1, 1_000);
    enforce(&f);

    f.client
        .set_quota(&5, &1_000, &rule(&f.e, &f.target), &f.account);

    let data = f.client.get_quota_data(&RULE_ID, &f.account);
    assert_eq!(data.max_items, 5);
    // O consumo já feito continua contando — subir o teto não zera a janela.
    assert_eq!(data.used, 1);
    enforce(&f);
}

#[test]
#[should_panic(expected = "Error(Contract, #6202)")]
fn zero_cap_is_rejected() {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(MintQuotaPolicyContract, ());
    let client = MintQuotaPolicyContractClient::new(&e, &contract_id);
    let account = Address::generate(&e);
    let target = Address::generate(&e);

    client.install(
        &MintQuotaParams {
            max_items: 0,
            period_ledgers: 1_000,
        },
        &rule(&e, &target),
        &account,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6201)")]
fn enforcing_without_install_fails() {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(MintQuotaPolicyContract, ());
    let client = MintQuotaPolicyContractClient::new(&e, &contract_id);
    let account = Address::generate(&e);
    let target = Address::generate(&e);

    client.enforce(
        &Context::Contract(ContractContext {
            contract: target.clone(),
            fn_name: Symbol::new(&e, "mint"),
            args: Vec::new(&e),
        }),
        &Vec::new(&e),
        &ContextRule {
            id: RULE_ID,
            context_type: ContextRuleType::CallContract(target),
            name: String::from_str(&e, "mint"),
            valid_until: None,
            signers: Vec::new(&e),
            signer_ids: Vec::new(&e),
            policies: Vec::new(&e),
            policy_ids: Vec::new(&e),
        },
        &account,
    );
}

#[test]
fn uninstall_clears_state() {
    let f = setup(3, 1_000);
    enforce(&f);
    f.client.uninstall(&rule(&f.e, &f.target), &f.account);

    // Sem params, a policy volta a recusar por não estar instalada.
    let result = f
        .client
        .try_get_quota_data(&RULE_ID, &f.account);
    assert!(result.is_err());
}

#[test]
fn install_params_round_trip_through_val() {
    // Garante que MintQuotaParams sobrevive à conversão que o smart account faz
    // ao guardar os install params na context rule.
    let e = Env::default();
    let params = MintQuotaParams {
        max_items: 7,
        period_ledgers: 720,
    };
    let val: soroban_sdk::Val = params.clone().into_val(&e);
    let back: MintQuotaParams = soroban_sdk::FromVal::from_val(&e, &val);
    assert_eq!(back, params);
}

#[test]
fn batch_consumes_one_unit_per_item() {
    let f = setup(10, 1_000);

    // mint_batch com 4 UUIDs desconta 4, não 1 — é o que faz "10.000 NFTs"
    // significar 10.000 itens e não 10.000 transações.
    let uuids = Vec::from_array(
        &f.e,
        [
            String::from_str(&f.e, "a"),
            String::from_str(&f.e, "b"),
            String::from_str(&f.e, "c"),
            String::from_str(&f.e, "d"),
        ],
    );

    f.client.enforce(
        &Context::Contract(ContractContext {
            contract: f.target.clone(),
            fn_name: Symbol::new(&f.e, "mint_batch"),
            args: Vec::from_array(
                &f.e,
                [
                    f.account.clone().into_val(&f.e),
                    uuids.into_val(&f.e),
                    String::from_str(&f.e, "nome").into_val(&f.e),
                ],
            ),
        }),
        &Vec::new(&f.e),
        &rule(&f.e, &f.target),
        &f.account,
    );

    assert_eq!(f.client.get_quota_data(&RULE_ID, &f.account).used, 4);
}

#[test]
#[should_panic(expected = "Error(Contract, #6200)")]
fn batch_bigger_than_the_cap_is_rejected_whole() {
    let f = setup(3, 1_000);

    let uuids = Vec::from_array(
        &f.e,
        [
            String::from_str(&f.e, "a"),
            String::from_str(&f.e, "b"),
            String::from_str(&f.e, "c"),
            String::from_str(&f.e, "d"),
        ],
    );

    // 4 itens com teto 3: o lote inteiro cai, não "passa 3 e corta 1".
    f.client.enforce(
        &Context::Contract(ContractContext {
            contract: f.target.clone(),
            fn_name: Symbol::new(&f.e, "mint_batch"),
            args: Vec::from_array(
                &f.e,
                [f.account.clone().into_val(&f.e), uuids.into_val(&f.e)],
            ),
        }),
        &Vec::new(&f.e),
        &rule(&f.e, &f.target),
        &f.account,
    );
}

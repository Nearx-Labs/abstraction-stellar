extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, Env, IntoVal,
};

use crate::contract::{Allowance, Treasury, TreasuryClient, TreasuryError};

const NOW: u64 = 1_800_000_000;

struct Setup<'a> {
    e: Env,
    client: TreasuryClient<'a>,
    owner: Address,
    operator: Address,
    user: Address,
    target: Address,
}

fn setup() -> Setup<'static> {
    let e = Env::default();
    e.ledger().with_mut(|l| l.timestamp = NOW);
    e.mock_all_auths_allowing_non_root_auth();

    let owner = Address::generate(&e);
    let operator = Address::generate(&e);
    let user = Address::generate(&e);
    let target = Address::generate(&e);

    let token_admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(token_admin.clone());
    let token = sac.address();

    // Financia o sponsor.
    StellarAssetClient::new(&e, &token).mint(&owner, &1_000_000);

    let contract_id = e.register(Treasury, (owner.clone(), operator.clone(), token));
    let client = TreasuryClient::new(&e, &contract_id);

    Setup { e, client, owner, operator, user, target }
}

fn default_allowance() -> Allowance {
    Allowance { max_per_tx: 100, max_per_day: 250, expires_at: None }
}

#[test]
fn deposit_withdraw_and_balance() {
    let s = setup();
    s.client.deposit(&s.owner, &500);
    assert_eq!(s.client.balance(), 500);

    let payer = Address::generate(&s.e);
    s.client.withdraw(&payer, &200);
    assert_eq!(s.client.balance(), 300);
}

#[test]
fn consume_respects_limits_and_accumulates() {
    let s = setup();
    s.client.allow_target(&s.target, &true);
    s.client.set_allowance(&s.user, &default_allowance());

    assert_eq!(s.client.consume(&s.user, &s.target, &100), 100);
    assert_eq!(s.client.consume(&s.user, &s.target, &100), 200);
    assert_eq!(s.client.get_usage_today(&s.user), 200);

    // 200 + 100 estoura o teto diário de 250.
    let res = s.client.try_consume(&s.user, &s.target, &100);
    assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(TreasuryError::DailyLimitExceeded as u32))));

    // 50 ainda cabe.
    assert_eq!(s.client.consume(&s.user, &s.target, &50), 250);
}

#[test]
fn daily_window_resets() {
    let s = setup();
    s.client.allow_target(&s.target, &true);
    s.client.set_allowance(&s.user, &default_allowance());

    s.client.consume(&s.user, &s.target, &100);
    s.client.consume(&s.user, &s.target, &100);
    assert_eq!(s.client.get_usage_today(&s.user), 200);

    // Dia seguinte: janela zera.
    s.e.ledger().with_mut(|l| l.timestamp = NOW + 86_400);
    assert_eq!(s.client.get_usage_today(&s.user), 0);
    assert_eq!(s.client.consume(&s.user, &s.target, &100), 100);
}

#[test]
fn per_tx_limit_enforced() {
    let s = setup();
    s.client.allow_target(&s.target, &true);
    s.client.set_allowance(&s.user, &default_allowance());

    let res = s.client.try_consume(&s.user, &s.target, &101);
    assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(TreasuryError::PerTxLimitExceeded as u32))));
}

#[test]
fn target_not_allowed_rejected() {
    let s = setup();
    s.client.set_allowance(&s.user, &default_allowance());

    let res = s.client.try_consume(&s.user, &s.target, &10);
    assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(TreasuryError::TargetNotAllowed as u32))));

    // Remoção da allowlist volta a bloquear.
    s.client.allow_target(&s.target, &true);
    s.client.consume(&s.user, &s.target, &10);
    s.client.allow_target(&s.target, &false);
    let res = s.client.try_consume(&s.user, &s.target, &10);
    assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(TreasuryError::TargetNotAllowed as u32))));
}

#[test]
fn self_invocation_bypasses_target_allowlist() {
    let s = setup();
    s.client.set_allowance(&s.user, &default_allowance());

    // Alvo == usuário (conta se auto-invocando): allowance governa, sem
    // precisar de allowlist.
    assert_eq!(s.client.consume(&s.user, &s.user, &10), 10);
}

#[test]
fn missing_or_expired_allowance_rejected() {
    let s = setup();
    s.client.allow_target(&s.target, &true);

    let res = s.client.try_consume(&s.user, &s.target, &10);
    assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(TreasuryError::NoAllowance as u32))));

    s.client.set_allowance(
        &s.user,
        &Allowance { max_per_tx: 100, max_per_day: 250, expires_at: Some(NOW - 1) },
    );
    let res = s.client.try_consume(&s.user, &s.target, &10);
    assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(TreasuryError::AllowanceExpired as u32))));
}

#[test]
fn only_operator_can_consume() {
    let s = setup();
    let e = &s.e;
    e.set_auths(&[]);

    // Owner configura allowlist e allowance via mock explícito.
    s.client
        .mock_auths(&[MockAuth {
            address: &s.owner,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "allow_target",
                args: (s.target.clone(), true).into_val(e),
                sub_invokes: &[],
            },
        }])
        .allow_target(&s.target, &true);
    s.client
        .mock_auths(&[MockAuth {
            address: &s.owner,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "set_allowance",
                args: (s.user.clone(), default_allowance()).into_val(e),
                sub_invokes: &[],
            },
        }])
        .set_allowance(&s.user, &default_allowance());

    // Um intruso assinando consume não é o operator.
    let intruder = Address::generate(e);
    let res = s
        .client
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "consume",
                args: (s.user.clone(), s.target.clone(), 10i128).into_val(e),
                sub_invokes: &[],
            },
        }])
        .try_consume(&s.user, &s.target, &10);
    assert!(res.is_err());

    // O operator consegue.
    let ok = s
        .client
        .mock_auths(&[MockAuth {
            address: &s.operator,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "consume",
                args: (s.user.clone(), s.target.clone(), 10i128).into_val(e),
                sub_invokes: &[],
            },
        }])
        .consume(&s.user, &s.target, &10);
    assert_eq!(ok, 10);
}

#[test]
fn only_owner_can_manage_policy() {
    let s = setup();
    let e = &s.e;
    e.set_auths(&[]);

    let intruder = Address::generate(e);
    let res = s
        .client
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "allow_target",
                args: (s.target.clone(), true).into_val(e),
                sub_invokes: &[],
            },
        }])
        .try_allow_target(&s.target, &true);
    assert!(res.is_err());

    let res = s
        .client
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "withdraw",
                args: (intruder.clone(), 1i128).into_val(e),
                sub_invokes: &[],
            },
        }])
        .try_withdraw(&intruder, &1);
    assert!(res.is_err());
}

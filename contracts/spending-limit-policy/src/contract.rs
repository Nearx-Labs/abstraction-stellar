//! # Spending Limit Policy Contract
//!
//! Policy reutilizável que limita o valor gasto por uma context rule numa
//! janela deslizante de ledgers — o guarda-corpo das session keys (Fase 4):
//! uma sessão é uma regra `CallContract(alvo)` com `valid_until` curto e
//! esta policy instalada, então a chave efêmera só movimenta até o limite
//! configurado, e nada além do contrato-alvo.
//!
//! A lógica (interceptação de `transfer`, histórico e janela) vem de
//! `stellar_accounts::policies::spending_limit`; este contrato é o wrapper
//! implantável, multi-tenant por `(smart_account, context_rule_id)`.
use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::{spending_limit, Policy},
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct SpendingLimitPolicyContract;

#[contractimpl]
impl Policy for SpendingLimitPolicyContract {
    type AccountParams = spending_limit::SpendingLimitAccountParams;

    /// Bloqueia `transfer`s que estourem o limite da janela e registra o
    /// gasto no histórico.
    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        spending_limit::enforce(e, &context, &authenticated_signers, &context_rule, &smart_account)
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        spending_limit::install(e, &install_params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        spending_limit::uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl SpendingLimitPolicyContract {
    /// Estado corrente (limite, período e histórico) de uma regra.
    pub fn get_spending_limit_data(
        e: Env,
        context_rule_id: u32,
        smart_account: Address,
    ) -> spending_limit::SpendingLimitData {
        spending_limit::get_spending_limit_data(&e, context_rule_id, &smart_account)
    }

    /// Ajusta o limite de uma regra existente (exige auth da conta).
    pub fn set_spending_limit(
        e: Env,
        spending_limit: i128,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        spending_limit::set_spending_limit(&e, spending_limit, &context_rule, &smart_account)
    }
}

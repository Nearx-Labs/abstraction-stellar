//! # Mint Quota Policy
//!
//! Limita **quantas chamadas** uma context rule pode fazer numa janela
//! deslizante de ledgers. É o complemento da spending-limit-policy: aquela
//! limita *valor*, esta limita *volume*.
//!
//! Existe por um motivo concreto. Quando um sistema (o backend de um tenant)
//! minta em nome de uma conta master, ele precisa de uma chave que assine
//! sozinha — sem passkey a cada operação. Dar essa chave sem teto significa
//! que um bug ou um vazamento minta indefinidamente. Aqui o tenant autoriza
//! um número: "este serviço pode registrar até N itens a cada janela", e o
//! contrato recusa o N+1.
//!
//! A garantia é on-chain: não depende do backend se comportar, nem de rate
//! limit em servidor nenhum.
//!
//! Multi-tenant por `(smart_account, context_rule_id)` — uma única instância
//! do contrato serve todas as contas.
use soroban_sdk::{
    auth::Context, contract, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Env, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_EXTEND: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = TTL_EXTEND - DAY_IN_LEDGERS;

/// Teto de itens guardados no histórico. A janela é deslizante, então o
/// histórico nunca precisa passar do limite configurado.
const MAX_HISTORY: u32 = 1_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MintQuotaError {
    /// A regra estourou o número de chamadas permitido na janela.
    QuotaExceeded = 6200,
    /// Policy não instalada para esta regra.
    NotInstalled = 6201,
    /// `max_calls` zero ou `period_ledgers` zero.
    ParamsInvalid = 6202,
}

/// Parâmetros de instalação.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintQuotaParams {
    /// Chamadas permitidas dentro da janela.
    pub max_calls: u32,
    /// Tamanho da janela, em ledgers (~5s cada).
    pub period_ledgers: u32,
}

/// Estado corrente, para a interface mostrar quanto sobrou.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintQuotaData {
    pub max_calls: u32,
    pub period_ledgers: u32,
    /// Chamadas dentro da janela agora.
    pub used: u32,
    /// Ledger em que a chamada mais antiga da janela sai (0 se não há).
    pub window_resets_at: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Params(Address, u32),
    History(Address, u32),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuotaInstalled {
    #[topic]
    pub smart_account: Address,
    #[topic]
    pub context_rule_id: u32,
    pub max_calls: u32,
    pub period_ledgers: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuotaConsumed {
    #[topic]
    pub smart_account: Address,
    #[topic]
    pub context_rule_id: u32,
    pub used: u32,
    pub max_calls: u32,
}

fn params_of(e: &Env, smart_account: &Address, rule_id: u32) -> MintQuotaParams {
    e.storage()
        .persistent()
        .get(&DataKey::Params(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, MintQuotaError::NotInstalled))
}

/// Remove do histórico as chamadas que já saíram da janela.
///
/// A comparação é `entry + period > current`, e não `entry > current - period`:
/// a segunda forma satura em zero nos primeiros ledgers da rede (e nos testes),
/// e aí uma chamada feita *agora* seria descartada na mesma hora — a cota
/// nunca contaria nada.
fn prune(e: &Env, history: &Vec<u32>, period: u32) -> Vec<u32> {
    let current = e.ledger().sequence();

    let mut kept = Vec::new(e);
    for entry in history.iter() {
        if entry.saturating_add(period) > current {
            kept.push_back(entry);
        }
    }
    kept
}

#[contract]
pub struct MintQuotaPolicyContract;

#[contractimpl]
impl Policy for MintQuotaPolicyContract {
    type AccountParams = MintQuotaParams;

    /// Conta a chamada e recusa se a janela já está cheia.
    ///
    /// Roda dentro do `__check_auth` da conta, então recusar aqui derruba a
    /// transação inteira — o N+1 simplesmente não acontece.
    fn enforce(
        e: &Env,
        _context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        let params = params_of(e, &smart_account, context_rule.id);
        let key = DataKey::History(smart_account.clone(), context_rule.id);

        let history: Vec<u32> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
        let mut window = prune(e, &history, params.period_ledgers);

        if window.len() >= params.max_calls || window.len() >= MAX_HISTORY {
            panic_with_error!(e, MintQuotaError::QuotaExceeded);
        }

        window.push_back(e.ledger().sequence());
        let used = window.len();

        e.storage().persistent().set(&key, &window);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        QuotaConsumed {
            smart_account,
            context_rule_id: context_rule.id,
            used,
            max_calls: params.max_calls,
        }
        .publish(e);
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if install_params.max_calls == 0 || install_params.period_ledgers == 0 {
            panic_with_error!(e, MintQuotaError::ParamsInvalid);
        }

        let key = DataKey::Params(smart_account.clone(), context_rule.id);
        e.storage().persistent().set(&key, &install_params);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        QuotaInstalled {
            smart_account,
            context_rule_id: context_rule.id,
            max_calls: install_params.max_calls,
            period_ledgers: install_params.period_ledgers,
        }
        .publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        e.storage()
            .persistent()
            .remove(&DataKey::Params(smart_account.clone(), context_rule.id));
        e.storage()
            .persistent()
            .remove(&DataKey::History(smart_account, context_rule.id));
    }
}

#[contractimpl]
impl MintQuotaPolicyContract {
    /// Quanto da cota já foi usado — é o que a tela do tenant mostra.
    pub fn get_quota_data(e: &Env, context_rule_id: u32, smart_account: Address) -> MintQuotaData {
        let params = params_of(e, &smart_account, context_rule_id);
        let history: Vec<u32> = e
            .storage()
            .persistent()
            .get(&DataKey::History(smart_account, context_rule_id))
            .unwrap_or(Vec::new(e));
        let window = prune(e, &history, params.period_ledgers);

        let window_resets_at = window
            .first()
            .map(|oldest| oldest + params.period_ledgers)
            .unwrap_or(0);

        MintQuotaData {
            max_calls: params.max_calls,
            period_ledgers: params.period_ledgers,
            used: window.len(),
            window_resets_at,
        }
    }

    /// Ajusta a cota de uma regra existente. Exige auth da conta — quem muda o
    /// teto é o dono, com passkey, nunca o serviço que consome a cota.
    pub fn set_quota(
        e: &Env,
        max_calls: u32,
        period_ledgers: u32,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if max_calls == 0 || period_ledgers == 0 {
            panic_with_error!(e, MintQuotaError::ParamsInvalid);
        }

        let key = DataKey::Params(smart_account.clone(), context_rule.id);
        let params = MintQuotaParams {
            max_calls,
            period_ledgers,
        };
        e.storage().persistent().set(&key, &params);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        QuotaInstalled {
            smart_account,
            context_rule_id: context_rule.id,
            max_calls,
            period_ledgers,
        }
        .publish(e);
    }
}

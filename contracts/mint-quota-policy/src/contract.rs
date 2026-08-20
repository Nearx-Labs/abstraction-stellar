//! # Mint Quota Policy
//!
//! Limita **quantos itens** uma context rule pode emitir numa janela
//! deslizante de ledgers. É o complemento da spending-limit-policy: aquela
//! limita *valor*, esta limita *volume*.
//!
//! A contagem é em itens, não em transações: um `mint_batch` de 100 consome
//! 100 da cota. É o número que o tenant entende quando autoriza "10.000 NFTs".
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
    panic_with_error, Address, Env, String, Symbol, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_EXTEND: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = TTL_EXTEND - DAY_IN_LEDGERS;

/// Teto de entradas no histórico. Cada entrada é uma chamada, não um item —
/// um lote de 100 ocupa uma linha só.
const MAX_HISTORY: u32 = 500;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MintQuotaError {
    /// A regra estourou o número de itens permitido na janela.
    QuotaExceeded = 6200,
    /// Policy não instalada para esta regra.
    NotInstalled = 6201,
    /// `max_items` zero ou `period_ledgers` zero.
    ParamsInvalid = 6202,
}

/// Parâmetros de instalação.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintQuotaParams {
    /// Itens permitidos dentro da janela.
    pub max_items: u32,
    /// Tamanho da janela, em ledgers (~5s cada).
    pub period_ledgers: u32,
}

/// Uma chamada registrada: em que ledger e quantos itens consumiu.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Consumption {
    pub ledger: u32,
    pub units: u32,
}

/// Estado corrente, para a interface mostrar quanto sobrou.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintQuotaData {
    pub max_items: u32,
    pub period_ledgers: u32,
    /// Itens consumidos dentro da janela agora.
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
    pub max_items: u32,
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
    pub max_items: u32,
}

fn params_of(e: &Env, smart_account: &Address, rule_id: u32) -> MintQuotaParams {
    e.storage()
        .persistent()
        .get(&DataKey::Params(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, MintQuotaError::NotInstalled))
}

/// Índice do argumento com a lista de UUIDs em `mint_batch(owner, uuids, …)`.
const BATCH_UUIDS_ARG: u32 = 1;

/// Quantas unidades esta chamada consome da cota.
///
/// A cota que um tenant concede é em **itens**, não em transações: autorizar
/// "10.000 NFTs" e ver um único `mint_batch` de 100 gastar 1 seria enganoso.
/// Por isso a policy olha os argumentos e desconta o tamanho do lote.
///
/// Uma função desconhecida no escopo da regra consome 1 — cota nunca é
/// contornada por engano, no máximo é cobrada a mais.
fn units_of(e: &Env, context: &Context) -> u32 {
    let Context::Contract(call) = context else {
        return 1;
    };

    if call.fn_name != Symbol::new(e, "mint_batch") {
        return 1;
    }

    match call.args.try_get(BATCH_UUIDS_ARG) {
        Ok(Some(arg)) => Vec::<String>::try_from_val(e, &arg)
            .map(|uuids| uuids.len().max(1))
            .unwrap_or(1),
        _ => 1,
    }
}

/// Remove do histórico as chamadas que já saíram da janela.
///
/// A comparação é `entry + period > current`, e não `entry > current - period`:
/// a segunda forma satura em zero nos primeiros ledgers da rede (e nos testes),
/// e aí uma chamada feita *agora* seria descartada na mesma hora — a cota
/// nunca contaria nada.
fn prune(e: &Env, history: &Vec<Consumption>, period: u32) -> Vec<Consumption> {
    let current = e.ledger().sequence();

    let mut kept = Vec::new(e);
    for entry in history.iter() {
        if entry.ledger.saturating_add(period) > current {
            kept.push_back(entry);
        }
    }
    kept
}

/// Itens consumidos na janela.
fn used_units(window: &Vec<Consumption>) -> u32 {
    let mut total: u32 = 0;
    for entry in window.iter() {
        total = total.saturating_add(entry.units);
    }
    total
}

#[contract]
pub struct MintQuotaPolicyContract;

#[contractimpl]
impl Policy for MintQuotaPolicyContract {
    type AccountParams = MintQuotaParams;

    /// Desconta os itens da chamada e recusa se a janela já está cheia.
    ///
    /// Roda dentro do `__check_auth` da conta, então recusar aqui derruba a
    /// transação inteira — o N+1 simplesmente não acontece.
    fn enforce(
        e: &Env,
        context: Context,
        _authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        let params = params_of(e, &smart_account, context_rule.id);
        let key = DataKey::History(smart_account.clone(), context_rule.id);

        let history: Vec<Consumption> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
        let mut window = prune(e, &history, params.period_ledgers);

        let units = units_of(e, &context);
        let used = used_units(&window).saturating_add(units);

        if used > params.max_items || window.len() >= MAX_HISTORY {
            panic_with_error!(e, MintQuotaError::QuotaExceeded);
        }

        window.push_back(Consumption {
            ledger: e.ledger().sequence(),
            units,
        });

        e.storage().persistent().set(&key, &window);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        QuotaConsumed {
            smart_account,
            context_rule_id: context_rule.id,
            used,
            max_items: params.max_items,
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

        if install_params.max_items == 0 || install_params.period_ledgers == 0 {
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
            max_items: install_params.max_items,
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
        let history: Vec<Consumption> = e
            .storage()
            .persistent()
            .get(&DataKey::History(smart_account, context_rule_id))
            .unwrap_or(Vec::new(e));
        let window = prune(e, &history, params.period_ledgers);

        let window_resets_at = window
            .first()
            .map(|oldest| oldest.ledger + params.period_ledgers)
            .unwrap_or(0);

        MintQuotaData {
            max_items: params.max_items,
            period_ledgers: params.period_ledgers,
            used: used_units(&window),
            window_resets_at,
        }
    }

    /// Ajusta a cota de uma regra existente. Exige auth da conta — quem muda o
    /// teto é o dono, com passkey, nunca o serviço que consome a cota.
    pub fn set_quota(
        e: &Env,
        max_items: u32,
        period_ledgers: u32,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if max_items == 0 || period_ledgers == 0 {
            panic_with_error!(e, MintQuotaError::ParamsInvalid);
        }

        let key = DataKey::Params(smart_account.clone(), context_rule.id);
        let params = MintQuotaParams {
            max_items,
            period_ledgers,
        };
        e.storage().persistent().set(&key, &params);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        QuotaInstalled {
            smart_account,
            context_rule_id: context_rule.id,
            max_items,
            period_ledgers,
        }
        .publish(e);
    }
}

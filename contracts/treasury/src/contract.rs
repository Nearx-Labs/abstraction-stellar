//! # Treasury — policy on-chain do paymaster
//!
//! Camada declarativa e auditável do fee sponsorship (Fase 3). O modelo é
//! híbrido, como recomendado no desenho do projeto:
//!
//! * **On-chain (este contrato)**: orçamento do sponsor em um token SEP-41,
//!   allowlist de contratos-alvo patrocináveis e allowance por usuário
//!   (limite por transação e por dia). Toda mutação emite evento — o gasto
//!   do sponsor é publicamente auditável.
//! * **Off-chain (services/relayer-proxy)**: simulação de custo, rate
//!   limiting, anti-abuse e a submissão patrocinada em si (fee-bump). O
//!   relayer é o `operator` deste contrato e debita as quotas via
//!   [`Treasury::consume`].
//!
//! Fees em Stellar são pagas em XLM no nível do ledger pela source/fee-bump —
//! um contrato não paga fee diretamente. O Treasury é a fonte de verdade de
//! policy e orçamento: o operator saca para reabastecer a conta pagadora e
//! presta contas debitando `consume` por transação patrocinada.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Env,
};
use stellar_access::ownable::{set_owner, Ownable};
use stellar_macros::only_owner;

const DAY_IN_SECS: u64 = 86_400;
const DAY_IN_LEDGERS: u32 = 17_280;
pub const TREASURY_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const TREASURY_TTL_THRESHOLD: u32 = TREASURY_EXTEND_AMOUNT - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TreasuryError {
    /// O contrato-alvo não está na allowlist de patrocínio.
    TargetNotAllowed = 5100,
    /// O usuário não tem allowance configurada.
    NoAllowance = 5101,
    /// A allowance do usuário expirou.
    AllowanceExpired = 5102,
    /// O valor excede o limite por transação.
    PerTxLimitExceeded = 5103,
    /// O valor excede o limite diário restante.
    DailyLimitExceeded = 5104,
    /// Valor não positivo.
    AmountInvalid = 5105,
}

/// Limites de patrocínio de um usuário (valores em stroops do token do
/// treasury).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Allowance {
    /// Máximo patrocinado numa única transação.
    pub max_per_tx: i128,
    /// Máximo patrocinado por dia (janela UTC de 86400s).
    pub max_per_day: i128,
    /// Expiração da allowance em unix time; `None` = sem expiração.
    pub expires_at: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Conta de serviço do relayer, autorizada a debitar quotas.
    Operator,
    /// Token SEP-41 que denomina o orçamento (ex.: XLM SAC).
    Token,
    /// Contrato-alvo elegível a patrocínio.
    AllowedTarget(Address),
    /// Allowance declarada por usuário (smart account).
    Allowance(Address),
    /// Consumo acumulado de (usuário, dia).
    Usage(Address, u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetAllowlistUpdated {
    #[topic]
    pub target: Address,
    pub allowed: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceSet {
    #[topic]
    pub user: Address,
    pub max_per_tx: i128,
    pub max_per_day: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeConsumed {
    #[topic]
    pub user: Address,
    #[topic]
    pub target: Address,
    pub amount: i128,
    pub used_today: i128,
}

fn day_bucket(e: &Env) -> u64 {
    e.ledger().timestamp() / DAY_IN_SECS
}

fn token_client(e: &Env) -> token::TokenClient<'_> {
    let token: Address = e.storage().instance().get(&DataKey::Token).unwrap();
    token::TokenClient::new(e, &token)
}

#[contract]
pub struct Treasury;

#[contractimpl]
impl Treasury {
    /// # Arguments
    ///
    /// * `owner` - Administra allowlists, allowances e saques.
    /// * `operator` - Conta de serviço do relayer; único endereço que debita
    ///   quotas via `consume`.
    /// * `token` - Token SEP-41 do orçamento (ex.: SAC do XLM).
    pub fn __constructor(e: &Env, owner: Address, operator: Address, token: Address) {
        set_owner(e, &owner);
        e.storage().instance().set(&DataKey::Operator, &operator);
        e.storage().instance().set(&DataKey::Token, &token);
    }

    // ------------------------------------------------------------------
    // Orçamento
    // ------------------------------------------------------------------

    /// Deposita orçamento de patrocínio (qualquer um pode financiar).
    pub fn deposit(e: &Env, from: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(e, TreasuryError::AmountInvalid);
        }
        token_client(e).transfer(&from, &e.current_contract_address(), &amount);
        Deposited { from, amount }.publish(e);
    }

    /// Saque do owner — tipicamente para reabastecer a conta pagadora de
    /// fees do relayer.
    #[only_owner]
    pub fn withdraw(e: &Env, to: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(e, TreasuryError::AmountInvalid);
        }
        token_client(e).transfer(&e.current_contract_address(), &to, &amount);
        Withdrawn { to, amount }.publish(e);
    }

    /// Saldo do orçamento no token configurado.
    pub fn balance(e: &Env) -> i128 {
        token_client(e).balance(&e.current_contract_address())
    }

    // ------------------------------------------------------------------
    // Policy declarativa
    // ------------------------------------------------------------------

    #[only_owner]
    pub fn set_operator(e: &Env, operator: Address) {
        e.storage().instance().set(&DataKey::Operator, &operator);
    }

    pub fn get_operator(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Operator).unwrap()
    }

    #[only_owner]
    pub fn allow_target(e: &Env, target: Address, allowed: bool) {
        let key = DataKey::AllowedTarget(target.clone());
        if allowed {
            e.storage().persistent().set(&key, &true);
            e.storage().persistent().extend_ttl(&key, TREASURY_TTL_THRESHOLD, TREASURY_EXTEND_AMOUNT);
        } else {
            e.storage().persistent().remove(&key);
        }
        TargetAllowlistUpdated { target, allowed }.publish(e);
    }

    pub fn is_target_allowed(e: &Env, target: Address) -> bool {
        e.storage().persistent().get(&DataKey::AllowedTarget(target)).unwrap_or(false)
    }

    #[only_owner]
    pub fn set_allowance(e: &Env, user: Address, allowance: Allowance) {
        if allowance.max_per_tx <= 0 || allowance.max_per_day <= 0 {
            panic_with_error!(e, TreasuryError::AmountInvalid);
        }
        let key = DataKey::Allowance(user.clone());
        e.storage().persistent().set(&key, &allowance);
        e.storage().persistent().extend_ttl(&key, TREASURY_TTL_THRESHOLD, TREASURY_EXTEND_AMOUNT);
        AllowanceSet {
            user,
            max_per_tx: allowance.max_per_tx,
            max_per_day: allowance.max_per_day,
        }
        .publish(e);
    }

    #[only_owner]
    pub fn remove_allowance(e: &Env, user: Address) {
        e.storage().persistent().remove(&DataKey::Allowance(user));
    }

    pub fn get_allowance(e: &Env, user: Address) -> Option<Allowance> {
        e.storage().persistent().get(&DataKey::Allowance(user))
    }

    /// Consumo do usuário na janela diária corrente.
    pub fn get_usage_today(e: &Env, user: Address) -> i128 {
        e.storage().persistent().get(&DataKey::Usage(user, day_bucket(e))).unwrap_or(0)
    }

    // ------------------------------------------------------------------
    // Débito de quota (relayer)
    // ------------------------------------------------------------------

    /// Debita `amount` (custo patrocinado, em stroops) da quota de `user`
    /// para uma transação que chama `target`. Somente o operator; falha se
    /// qualquer regra declarativa for violada.
    pub fn consume(e: &Env, user: Address, target: Address, amount: i128) -> i128 {
        let operator: Address = e.storage().instance().get(&DataKey::Operator).unwrap();
        operator.require_auth();

        if amount <= 0 {
            panic_with_error!(e, TreasuryError::AmountInvalid);
        }
        if !Self::is_target_allowed(e, target.clone()) {
            panic_with_error!(e, TreasuryError::TargetNotAllowed);
        }

        let allowance = Self::get_allowance(e, user.clone())
            .unwrap_or_else(|| panic_with_error!(e, TreasuryError::NoAllowance));
        if let Some(expires_at) = allowance.expires_at {
            if e.ledger().timestamp() > expires_at {
                panic_with_error!(e, TreasuryError::AllowanceExpired);
            }
        }
        if amount > allowance.max_per_tx {
            panic_with_error!(e, TreasuryError::PerTxLimitExceeded);
        }

        let usage_key = DataKey::Usage(user.clone(), day_bucket(e));
        let used: i128 = e.storage().persistent().get(&usage_key).unwrap_or(0);
        let used_today = used + amount;
        if used_today > allowance.max_per_day {
            panic_with_error!(e, TreasuryError::DailyLimitExceeded);
        }
        e.storage().persistent().set(&usage_key, &used_today);
        // TTL curto: a janela diária não precisa sobreviver 30 dias, mas o
        // extend mínimo cobre relatórios e disputas.
        e.storage().persistent().extend_ttl(&usage_key, DAY_IN_LEDGERS, 2 * DAY_IN_LEDGERS);

        FeeConsumed { user, target, amount, used_today }.publish(e);
        used_today
    }
}

#[contractimpl(contracttrait)]
impl Ownable for Treasury {}

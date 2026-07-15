//! # Recovery — guardians + timelock (Fase 5)
//!
//! Sem seed phrase, perder todos os devices não pode significar perder a
//! conta. A primeira linha de defesa é multi-device (registrar mais de uma
//! passkey na regra Default via `add_signer`/`batch_add_signer`); este módulo
//! é a segunda: um quórum de guardians reinstala acesso após um timelock.
//!
//! ## Desenho
//!
//! * **Guardians** são `Address` Soroban — podem ser amigos (G-address),
//!   outra smart account do próprio usuário, ou um serviço institucional
//!   (ex.: o auth-issuer como guardian dá "email recovery com delay" de
//!   graça, compondo com a Fase 2).
//! * **start/approve** exigem `require_auth` do guardian. O iniciador já
//!   conta como aprovação.
//! * **Timelock**: `finalize` só executa após `timelock_secs` do início — a
//!   janela de veto do dono real.
//! * **Cancel** exige auth da própria conta (qualquer autenticador vivo):
//!   quem ainda tem um device sempre vence uma tentativa de takeover.
//! * **Finalize** é permissionless (após quórum + timelock) e instala o novo
//!   signer numa **nova** regra `Default` — não depende do estado da regra 0
//!   (que pode ter sido perdida/alterada). Com o acesso de volta, o usuário
//!   remove os signers antigos pelo fluxo administrativo normal.
//! * **Cooldown** após um recovery bem-sucedido limita a cadência de
//!   takeovers consecutivos.
//!
//! Recovery nunca é instantâneo, e guardians sozinhos nunca movimentam
//! fundos — só reinstalam autenticadores, com dono podendo vetar.
use soroban_sdk::{
    contracterror, contractevent, contracttype, panic_with_error, Address, Env, String, Vec,
};
use stellar_accounts::smart_account::{self, ContextRuleType, Signer};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RecoveryError {
    /// Não há policy de recovery configurada.
    PolicyNotSet = 5200,
    /// O endereço não é guardian.
    NotGuardian = 5201,
    /// Já existe um recovery em andamento.
    RecoveryAlreadyActive = 5202,
    /// Não há recovery ativo com esse id.
    RecoveryNotFound = 5203,
    /// Guardian já aprovou este recovery.
    AlreadyApproved = 5204,
    /// Quórum de guardians ainda não atingido.
    ThresholdNotMet = 5205,
    /// O timelock ainda não expirou.
    TimelockNotExpired = 5206,
    /// Cooldown pós-recovery ainda ativo.
    CooldownActive = 5207,
    /// Parâmetros inválidos (threshold zero ou maior que nº de guardians).
    InvalidPolicy = 5208,
}

/// Policy de recovery da conta.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryPolicy {
    /// Endereços autorizados a iniciar/aprovar recovery.
    pub guardians: Vec<Address>,
    /// Aprovações necessárias.
    pub threshold: u32,
    /// Segundos entre o início e a possibilidade de finalizar.
    pub timelock_secs: u64,
    /// Segundos após um finalize em que novo recovery é bloqueado.
    pub cooldown_secs: u64,
}

/// Estado de um recovery em andamento.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryState {
    pub id: u32,
    /// Novo autenticador a instalar (ex.: passkey do device novo).
    pub new_signer: Signer,
    pub approvals: Vec<Address>,
    pub started_at: u64,
    pub executable_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum RecoveryKey {
    // Nomes prefixados: variantes unit de #[contracttype] serializam pelo
    // nome do símbolo, e o stellar-accounts já usa "NextId"/"Count" no
    // instance storage — sem prefixo haveria colisão de chave.
    RecPolicy,
    RecActive,
    RecNextId,
    RecLastFinalizedAt,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryStarted {
    #[topic]
    pub recovery_id: u32,
    pub guardian: Address,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryApproved {
    #[topic]
    pub recovery_id: u32,
    pub guardian: Address,
    pub approvals: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryCanceled {
    #[topic]
    pub recovery_id: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryFinalized {
    #[topic]
    pub recovery_id: u32,
    pub new_rule_id: u32,
}

fn get_policy(e: &Env) -> RecoveryPolicy {
    e.storage()
        .instance()
        .get(&RecoveryKey::RecPolicy)
        .unwrap_or_else(|| panic_with_error!(e, RecoveryError::PolicyNotSet))
}

fn require_guardian(e: &Env, policy: &RecoveryPolicy, guardian: &Address) {
    guardian.require_auth();
    if !policy.guardians.contains(guardian) {
        panic_with_error!(e, RecoveryError::NotGuardian);
    }
}

fn get_active(e: &Env, recovery_id: u32) -> RecoveryState {
    let state: RecoveryState = e
        .storage()
        .instance()
        .get(&RecoveryKey::RecActive)
        .unwrap_or_else(|| panic_with_error!(e, RecoveryError::RecoveryNotFound));
    if state.id != recovery_id {
        panic_with_error!(e, RecoveryError::RecoveryNotFound);
    }
    state
}

/// Define/substitui a policy. Exige auth da conta (step-up: passkey).
pub fn set_recovery_policy(e: &Env, policy: RecoveryPolicy) {
    e.current_contract_address().require_auth();
    if policy.threshold == 0 || policy.threshold > policy.guardians.len() {
        panic_with_error!(e, RecoveryError::InvalidPolicy);
    }
    e.storage().instance().set(&RecoveryKey::RecPolicy, &policy);
}

pub fn get_recovery_policy(e: &Env) -> Option<RecoveryPolicy> {
    e.storage().instance().get(&RecoveryKey::RecPolicy)
}

pub fn get_active_recovery(e: &Env) -> Option<RecoveryState> {
    e.storage().instance().get(&RecoveryKey::RecActive)
}

/// Guardian inicia o recovery propondo o novo autenticador. A aprovação do
/// iniciador já conta para o quórum.
pub fn start_recovery(e: &Env, guardian: Address, new_signer: Signer) -> u32 {
    let policy = get_policy(e);
    require_guardian(e, &policy, &guardian);

    if e.storage().instance().has(&RecoveryKey::RecActive) {
        panic_with_error!(e, RecoveryError::RecoveryAlreadyActive);
    }
    let now = e.ledger().timestamp();
    let last: u64 = e.storage().instance().get(&RecoveryKey::RecLastFinalizedAt).unwrap_or(0);
    if last > 0 && now < last + policy.cooldown_secs {
        panic_with_error!(e, RecoveryError::CooldownActive);
    }

    let id: u32 = e.storage().instance().get(&RecoveryKey::RecNextId).unwrap_or(0);
    e.storage().instance().set(&RecoveryKey::RecNextId, &(id + 1));

    let executable_at = now + policy.timelock_secs;
    let state = RecoveryState {
        id,
        new_signer,
        approvals: soroban_sdk::vec![e, guardian.clone()],
        started_at: now,
        executable_at,
    };
    e.storage().instance().set(&RecoveryKey::RecActive, &state);

    RecoveryStarted { recovery_id: id, guardian, executable_at }.publish(e);
    id
}

/// Aprovação adicional de guardian.
pub fn approve_recovery(e: &Env, recovery_id: u32, guardian: Address) -> u32 {
    let policy = get_policy(e);
    require_guardian(e, &policy, &guardian);

    let mut state = get_active(e, recovery_id);
    if state.approvals.contains(&guardian) {
        panic_with_error!(e, RecoveryError::AlreadyApproved);
    }
    state.approvals.push_back(guardian.clone());
    e.storage().instance().set(&RecoveryKey::RecActive, &state);

    let approvals = state.approvals.len();
    RecoveryApproved { recovery_id, guardian, approvals }.publish(e);
    approvals
}

/// Veto do dono: qualquer autenticador vivo da conta cancela o recovery.
pub fn cancel_recovery(e: &Env, recovery_id: u32) {
    e.current_contract_address().require_auth();
    let _ = get_active(e, recovery_id);
    e.storage().instance().remove(&RecoveryKey::RecActive);
    RecoveryCanceled { recovery_id }.publish(e);
}

/// Permissionless: com quórum e timelock cumpridos, instala o novo signer
/// numa nova regra `Default` e devolve o controle da conta.
pub fn finalize_recovery(e: &Env, recovery_id: u32) -> u32 {
    let policy = get_policy(e);
    let state = get_active(e, recovery_id);

    if state.approvals.len() < policy.threshold {
        panic_with_error!(e, RecoveryError::ThresholdNotMet);
    }
    if e.ledger().timestamp() < state.executable_at {
        panic_with_error!(e, RecoveryError::TimelockNotExpired);
    }

    let rule = smart_account::add_context_rule(
        e,
        &ContextRuleType::Default,
        &String::from_str(e, "recovered"),
        None,
        &soroban_sdk::vec![e, state.new_signer.clone()],
        &soroban_sdk::Map::new(e),
    );

    e.storage().instance().remove(&RecoveryKey::RecActive);
    e.storage().instance().set(&RecoveryKey::RecLastFinalizedAt, &e.ledger().timestamp());

    RecoveryFinalized { recovery_id, new_rule_id: rule.id }.publish(e);
    rule.id
}

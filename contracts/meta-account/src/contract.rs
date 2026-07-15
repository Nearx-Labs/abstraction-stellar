//! # MetaAccount — smart account com autenticação plugável
//!
//! Conta de contrato (contract account) construída sobre o framework de smart
//! accounts da OpenZeppelin (`stellar-accounts`). A autorização é organizada
//! em *context rules*: cada regra vincula um conjunto de signers (passkeys
//! WebAuthn, chaves Ed25519 ou endereços delegados) e policies (limites de
//! gasto, thresholds) a um escopo de operação (`Default`,
//! `CallContract(addr)` ou `CreateContract(wasm_hash)`).
//!
//! Fase 1 do roadmap: passkey como signer primário via verificador WebAuthn
//! externo. Session keys (regras `CallContract` com `valid_until`), email
//! attestation e recovery entram nas fases seguintes como novas regras e
//! policies — sem mudar este núcleo.
//!
//! Anti-replay, expiração de assinatura e binding de rede/invocação são
//! garantidos pelo host do Soroban (nonce do `SorobanAuthorizationEntry`);
//! este contrato só verifica provas criptográficas e aplica as policies.
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, BytesN, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint, Signer, SmartAccount,
    SmartAccountError,
};
use stellar_contract_utils::upgradeable::{self, Upgradeable};

use crate::recovery;

#[contract]
pub struct MetaAccount;

#[contractimpl]
impl MetaAccount {
    /// Cria a regra de contexto `Default` (id 0) com os signers e policies
    /// iniciais — tipicamente um único signer passkey apontando para o
    /// verificador WebAuthn.
    ///
    /// # Arguments
    ///
    /// * `signers` - Signers autorizados (External: verificador + key data,
    ///   ou Delegated: um Address Soroban).
    /// * `policies` - Mapa de contratos de policy para seus parâmetros de
    ///   instalação. Pode ser vazio se houver ao menos um signer.
    pub fn __constructor(e: &Env, signers: Vec<Signer>, policies: Map<Address, Val>) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, "default"),
            None,
            &signers,
            &policies,
        );
    }

    /// Adiciona vários signers a uma regra existente em uma única transação
    /// (ex.: registrar um segundo device como backup).
    pub fn batch_add_signer(e: &Env, context_rule_id: u32, signers: Vec<Signer>) {
        e.current_contract_address().require_auth();

        smart_account::batch_add_signer(e, context_rule_id, &signers);
    }

    // ------------------------------------------------------------------
    // Recovery (Fase 5) — ver src/recovery.rs para o desenho completo.
    // ------------------------------------------------------------------

    /// Define guardians/threshold/timelock/cooldown. Step-up: exige auth da
    /// conta (passkey), nunca email ou session key sozinhos — regras
    /// `CallContract` não autorizam chamadas à própria conta.
    pub fn set_recovery_policy(e: &Env, policy: recovery::RecoveryPolicy) {
        recovery::set_recovery_policy(e, policy);
    }

    pub fn get_recovery_policy(e: &Env) -> Option<recovery::RecoveryPolicy> {
        recovery::get_recovery_policy(e)
    }

    pub fn get_active_recovery(e: &Env) -> Option<recovery::RecoveryState> {
        recovery::get_active_recovery(e)
    }

    /// Guardian inicia recovery propondo o novo autenticador.
    pub fn start_recovery(e: &Env, guardian: Address, new_signer: Signer) -> u32 {
        recovery::start_recovery(e, guardian, new_signer)
    }

    /// Aprovação adicional de guardian rumo ao quórum.
    pub fn approve_recovery(e: &Env, recovery_id: u32, guardian: Address) -> u32 {
        recovery::approve_recovery(e, recovery_id, guardian)
    }

    /// Veto do dono: qualquer autenticador vivo cancela a tentativa.
    pub fn cancel_recovery(e: &Env, recovery_id: u32) {
        recovery::cancel_recovery(e, recovery_id);
    }

    /// Permissionless após quórum + timelock: instala o novo signer numa
    /// nova regra `Default`, devolvendo o controle da conta.
    pub fn finalize_recovery(e: &Env, recovery_id: u32) -> u32 {
        recovery::finalize_recovery(e, recovery_id)
    }
}

#[contractimpl]
impl CustomAccountInterface for MetaAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    /// Ponto central de autorização, chamado pelo host a cada `require_auth`
    /// desta conta. Delega ao framework: valida cada contexto contra a regra
    /// selecionada em `signatures.context_rule_ids`, autentica cada signer
    /// (via verificador externo ou `require_auth` delegado) sobre o digest
    /// `sha256(signature_payload || context_rule_ids.to_xdr())` e aplica
    /// todas as policies das regras.
    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

// Gerenciamento de regras/signers/policies (add/remove/update) exposto pelo
// trait da lib; toda mutação exige require_auth da própria conta.
#[contractimpl(contracttrait)]
impl SmartAccount for MetaAccount {}

// `execute(target, fn, args)`: chamada genérica a partir da conta.
#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for MetaAccount {}

#[contractimpl]
impl Upgradeable for MetaAccount {
    fn upgrade(e: &Env, new_wasm_hash: BytesN<32>, _operator: Address) {
        e.current_contract_address().require_auth();
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

//! # Anchor Ledger — âncora de eventos de negócio
//!
//! O complemento do [demo-ledger](../../demo-ledger): lá vive o **inventário**
//! (um item por UUID, com dono que muda na venda); aqui vive o **histórico
//! contábil** — compra de crédito, dedução, reembolso, split, cancelamento.
//! Eventos que não são item e não têm dono, mas precisam de prova de que
//! aconteceram e de que o registro off-chain não foi editado depois.
//!
//! On-chain vai só o indispensável: tenant, tipo, chave de negócio, valor e o
//! **sha256 completo** do JSON que o sistema consumidor guarda. O payload em si
//! fica fora — um Soroban cobra por byte armazenado, e o hash já commita o
//! conteúdo. Os dois lados se auditam mutuamente: o banco tem o texto, a chain
//! tem o hash e o carimbo de tempo.
//!
//! Multi-tenant por campo, não por deploy: uma instância serve todos os
//! tenants, e cada registro carrega o `tenant_id`. O que separa um tenant do
//! outro na autorização é o `caller` — a conta mestre que assina.
//!
//! ## Por que não é o admin quem assina
//!
//! A versão original deste contrato (escrita para a migração XION→Stellar do
//! MintVRS) tinha um `Admin` fixo gravado no construtor. Sob abstração de conta
//! isso não serve: quem invoca é a **conta mestre de cada tenant**, e um admin
//! global significaria uma chave só assinando por todo mundo. Aqui o `caller`
//! é argumento e dá `require_auth()` — então a autorização passa pelo
//! `__check_auth` da smart account e a policy instalada na regra é aplicada
//! on-chain, igual ao `mint_batch` do demo-ledger.
//!
//! ## Quem pode escrever
//!
//! `require_auth()` sozinho só prova que o caller assinou — qualquer conta
//! assinava um registro com o `tenant_id` de outro e poluía o histórico dele, e
//! 256 tenants inventados enchiam a lista e travavam o primeiro registro de um
//! tenant de verdade. Por isso só escreve quem está na allowlist, mantida pelo
//! `registrar` (a chave operacional do serviço, que habilita a mestre de cada
//! tenant no provisionamento). O `admin` (chave fria) troca o registrar e faz
//! upgrade — os mesmos papéis do demo-ledger.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, String, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
/// TTL alvo: 120 dias, o mínimo com que a mainnet já cria entrada persistente.
/// Registro novo nasce com isso e não paga extensão nenhuma; o que é tocado de
/// novo (instância, contadores) é renovado ~1 dia por vez, barato. Um alvo
/// maior fazia cada mint pagar aluguel adiantado: com 178 dias, ~6 XLM por
/// chave na testnet (onde o aluguel por KB é ~6,7x o da mainnet e o mínimo é
/// 7 dias), medido em 2026-10-12.
const RECORD_TTL: u32 = 120 * DAY_IN_LEDGERS;
const RECORD_TTL_THRESHOLD: u32 = RECORD_TTL - DAY_IN_LEDGERS;

/// UUID de tenant tem 36 chars; a folga cobre slug.
pub const MAX_TENANT_LEN: u32 = 64;
/// Chave de negócio (transactionId / orderId / listingId). O backend já corta
/// em 128 antes de mandar.
pub const MAX_REFERENCE_LEN: u32 = 128;
/// Instance storage é uma entrada XDR única (teto de 64 KB). 256 tenants de 36
/// chars ficam em ~11 KB, bem dentro da margem.
pub const MAX_TENANTS: u32 = 256;
/// Teto de leitura por página, para caber no budget de read entries.
pub const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AnchorError {
    /// `seq` não existe.
    RecordNotFound = 6300,
    /// `tenant_id` vazio ou acima de MAX_TENANT_LEN.
    TenantInvalid = 6301,
    /// `reference` acima de MAX_REFERENCE_LEN.
    ReferenceInvalid = 6302,
    /// A lista consultável de tenants encheu.
    TooManyTenants = 6303,
    /// O caller não está na allowlist de quem pode escrever.
    NotWriter = 6304,
}

/// Um evento ancorado.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorRecord {
    /// Posição global, na ordem em que os registros entraram.
    pub seq: u64,
    /// Conta que assinou o registro — a mestre do tenant.
    pub writer: Address,
    /// UUID (ou slug) do tenant do sistema consumidor.
    pub tenant_id: String,
    /// `credit_purchase`, `web2_purchase`, `refund`, `marketplace_transfer`, …
    pub kind: Symbol,
    /// Chave de negócio, para achar o registro do outro lado.
    pub reference: String,
    /// sha256 **completo** do JSON persistido off-chain.
    pub payload_hash: BytesN<32>,
    /// Valor do evento, na menor unidade. `1` quando o evento não tem valor.
    pub amount: i128,
    pub timestamp: u64,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Próximo `seq` a atribuir.
    Seq,
    /// Lista consultável de tenants que já registraram algo.
    Tenants,
    /// seq global -> registro.
    Record(u64),
    /// tenant -> quantidade de registros.
    TCount(String),
    /// (tenant, índice local) -> seq global.
    TRec(String, u32),
    /// Chave fria: troca o registrar e faz upgrade (instance).
    Admin,
    /// Chave operacional: mantém a allowlist de writers (instance).
    Registrar,
    /// Allowlist de writers (instance).
    Writer(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Registered {
    #[topic]
    pub tenant_id: String,
    #[topic]
    pub kind: Symbol,
    #[topic]
    pub writer: Address,
    pub seq: u64,
    pub payload_hash: BytesN<32>,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriterUpdated {
    #[topic]
    pub writer: Address,
    pub allowed: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleUpdated {
    #[topic]
    pub role: Symbol,
    pub account: Address,
}

fn admin_of(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

fn registrar_of(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Registrar).unwrap()
}

fn extend_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(RECORD_TTL_THRESHOLD, RECORD_TTL);
}

fn validate(e: &Env, tenant_id: &String, reference: &String) {
    if tenant_id.len() == 0 || tenant_id.len() > MAX_TENANT_LEN {
        panic_with_error!(e, AnchorError::TenantInvalid);
    }
    if reference.len() > MAX_REFERENCE_LEN {
        panic_with_error!(e, AnchorError::ReferenceInvalid);
    }
}

/// Renova o TTL junto com a escrita. Uma entrada que expira leva o registro
/// embora — e o ponto do contrato é justamente o registro não sumir.
fn bump<K>(e: &Env, key: &K)
where
    K: soroban_sdk::IntoVal<Env, soroban_sdk::Val> + soroban_sdk::TryFromVal<Env, soroban_sdk::Val>,
{
    e.storage()
        .persistent()
        .extend_ttl(key, RECORD_TTL_THRESHOLD, RECORD_TTL);
}

#[contract]
pub struct AnchorLedger;

#[contractimpl]
impl AnchorLedger {
    /// `admin` é a chave fria (upgrade e troca do registrar); `registrar` é a
    /// chave operacional do serviço.
    pub fn __constructor(e: &Env, admin: Address, registrar: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Registrar, &registrar);
        extend_instance(e);
    }

    /// Ancora um evento e devolve o `seq` global atribuído.
    ///
    /// `caller.require_auth()` é o que amarra o contrato à abstração de conta:
    /// quando o caller é uma smart account, a autorização passa pelo
    /// `__check_auth` dela, e a policy instalada na regra que assinou aplica o
    /// teto do tenant aqui, on-chain.
    ///
    /// Não deduplica por `reference` de propósito: dois `credit_lock` da mesma
    /// transação são dois eventos distintos, e o contrato não tem como saber
    /// qual repetição é erro. Quem deduplica é o consumidor, que tem o
    /// contexto.
    pub fn register(
        e: &Env,
        caller: Address,
        tenant_id: String,
        kind: Symbol,
        reference: String,
        payload_hash: BytesN<32>,
        amount: i128,
    ) -> u64 {
        caller.require_auth();
        let allowed: bool = e
            .storage()
            .instance()
            .get(&DataKey::Writer(caller.clone()))
            .unwrap_or(false);
        if !allowed {
            panic_with_error!(e, AnchorError::NotWriter);
        }
        validate(e, &tenant_id, &reference);

        let seq: u64 = e.storage().instance().get(&DataKey::Seq).unwrap_or(0);

        let record = AnchorRecord {
            seq,
            writer: caller.clone(),
            tenant_id: tenant_id.clone(),
            kind: kind.clone(),
            reference,
            payload_hash: payload_hash.clone(),
            amount,
            timestamp: e.ledger().timestamp(),
            ledger: e.ledger().sequence(),
        };

        let record_key = DataKey::Record(seq);
        e.storage().persistent().set(&record_key, &record);
        bump(e, &record_key);

        // Índice por tenant: TCount conta, TRec mapeia índice local -> seq.
        let count_key = DataKey::TCount(tenant_id.clone());
        let idx: u32 = e.storage().persistent().get(&count_key).unwrap_or(0);

        let tenant_rec_key = DataKey::TRec(tenant_id.clone(), idx);
        e.storage().persistent().set(&tenant_rec_key, &seq);
        bump(e, &tenant_rec_key);

        e.storage().persistent().set(&count_key, &(idx + 1));
        bump(e, &count_key);

        // Primeiro registro do tenant: entra na lista consultável.
        if idx == 0 {
            let mut tenants: Vec<String> = e
                .storage()
                .instance()
                .get(&DataKey::Tenants)
                .unwrap_or_else(|| Vec::new(e));
            if tenants.len() >= MAX_TENANTS {
                panic_with_error!(e, AnchorError::TooManyTenants);
            }
            tenants.push_back(tenant_id.clone());
            e.storage().instance().set(&DataKey::Tenants, &tenants);
        }

        e.storage().instance().set(&DataKey::Seq, &(seq + 1));
        extend_instance(e);

        Registered {
            tenant_id,
            kind,
            writer: caller,
            seq,
            payload_hash,
            amount,
        }
        .publish(e);

        seq
    }

    // --- papéis ---------------------------------------------------------

    /// Habilita ou desabilita uma conta para registrar. Só o registrar.
    pub fn set_writer(e: &Env, writer: Address, allowed: bool) {
        registrar_of(e).require_auth();
        let key = DataKey::Writer(writer.clone());
        if allowed {
            e.storage().instance().set(&key, &true);
        } else {
            e.storage().instance().remove(&key);
        }
        extend_instance(e);
        WriterUpdated { writer, allowed }.publish(e);
    }

    pub fn is_writer(e: &Env, account: Address) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Writer(account))
            .unwrap_or(false)
    }

    pub fn set_registrar(e: &Env, registrar: Address) {
        admin_of(e).require_auth();
        e.storage().instance().set(&DataKey::Registrar, &registrar);
        extend_instance(e);
        RoleUpdated {
            role: Symbol::new(e, "registrar"),
            account: registrar,
        }
        .publish(e);
    }

    pub fn set_admin(e: &Env, admin: Address) {
        admin_of(e).require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance(e);
        RoleUpdated {
            role: Symbol::new(e, "admin"),
            account: admin,
        }
        .publish(e);
    }

    pub fn admin(e: &Env) -> Address {
        admin_of(e)
    }

    pub fn registrar(e: &Env) -> Address {
        registrar_of(e)
    }

    /// Troca o wasm. Só o admin. O storage é preservado.
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        admin_of(e).require_auth();
        e.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // --- leitura --------------------------------------------------------

    pub fn get_record(e: &Env, seq: u64) -> AnchorRecord {
        e.storage()
            .persistent()
            .get(&DataKey::Record(seq))
            .unwrap_or_else(|| panic_with_error!(e, AnchorError::RecordNotFound))
    }

    /// `true` quando o hash bate com o registro — é a verificação que fecha o
    /// ciclo: o consumidor recalcula o sha256 do JSON que guardou e pergunta
    /// aqui se é o mesmo que foi ancorado.
    pub fn verify(e: &Env, seq: u64, payload_hash: BytesN<32>) -> bool {
        match e
            .storage()
            .persistent()
            .get::<DataKey, AnchorRecord>(&DataKey::Record(seq))
        {
            Some(record) => record.payload_hash == payload_hash,
            None => false,
        }
    }

    pub fn total_records(e: &Env) -> u64 {
        e.storage().instance().get(&DataKey::Seq).unwrap_or(0)
    }

    pub fn tenants(e: &Env) -> Vec<String> {
        e.storage()
            .instance()
            .get(&DataKey::Tenants)
            .unwrap_or_else(|| Vec::new(e))
    }

    pub fn tenant_count(e: &Env, tenant_id: String) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::TCount(tenant_id))
            .unwrap_or(0)
    }

    /// Página de registros de um tenant. `limit` é clampado em `MAX_PAGE`, e
    /// `start` além do total devolve vazio em vez de estourar — paginar até o
    /// fim é o caso normal de quem varre o histórico.
    pub fn tenant_records(
        e: &Env,
        tenant_id: String,
        start: u32,
        limit: u32,
    ) -> Vec<AnchorRecord> {
        let total: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::TCount(tenant_id.clone()))
            .unwrap_or(0);

        let mut out = Vec::new(e);
        if start >= total {
            return out;
        }

        let capped = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let end = if total < start.saturating_add(capped) {
            total
        } else {
            start.saturating_add(capped)
        };

        for idx in start..end {
            let seq: u64 = match e
                .storage()
                .persistent()
                .get(&DataKey::TRec(tenant_id.clone(), idx))
            {
                Some(s) => s,
                None => continue,
            };
            if let Some(rec) = e
                .storage()
                .persistent()
                .get::<DataKey, AnchorRecord>(&DataKey::Record(seq))
            {
                out.push_back(rec);
            }
        }
        out
    }
}

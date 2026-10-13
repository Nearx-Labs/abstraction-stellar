//! # Demo Ledger — invent\u{e1}rio de NFTs por UUID
//!
//! Modelo do produto: a conta mestre de um tenant minta um lote de itens
//! (10.000, por exemplo) e fica dona de todos. Cada item é identificado por um
//! **UUID gerado fora da chain** — é a mesma chave que o banco do sistema
//! consumidor guarda, então os dois lados falam do mesmo item sem precisar de
//! tabela de conversão.
//!
//! A venda no marketplace é um `transfer(uuid, comprador)`: a posse corrente
//! fica on-chain e qualquer um pode verificar quem detém o quê.
//!
//! Cada item carrega **campos livres** definidos por quem minta — é o que
//! permite anexar os metadados do negócio (campanha, lote, assento…) ao
//! registro, dentro do contrato.
//!
//! Os tetos de tamanho são deliberados: a fee é patrocinada, então campo livre
//! sem limite vira custo do sponsor.
//!
//! ## Índices paginados
//!
//! A primeira versão guardava os UUIDs de cada dono e o invent\u{e1}rio inteiro em
//! dois `Vec` — uma entrada de storage cada, regravada inteira a cada mint.
//! Uma entrada tem teto de 64 KB e a transação tem teto de bytes escritos, então
//! o contrato parava de aceitar mint por volta de 1.100–1.450 itens **no total**,
//! somando todos os tenants. Aqui cada posição é uma entrada própria — o mesmo
//! padrão contador + `(dono, índice)` do anchor-ledger —, e o custo de um mint
//! não cresce com o tamanho do invent\u{e1}rio.
//!
//! ## Quem pode mintar
//!
//! O UUID é escolhido fora da chain e, no MintVRS, é visível ao comprador antes
//! de o item existir. Com mint aberto, qualquer conta mintava esse UUID primeiro
//! e o mint legítimo falhava com `UuidTaken`. Por isso só minta quem está na
//! allowlist, mantida pelo `registrar` (a chave operacional do serviço). O
//! `admin` (chave fria) troca o registrar e faz upgrade do wasm.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, Map, String, Vec,
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

pub const MAX_FIELDS: u32 = 16;
pub const MAX_KEY_LEN: u32 = 32;
pub const MAX_VALUE_LEN: u32 = 256;
pub const MAX_NAME_LEN: u32 = 64;
pub const MAX_URI_LEN: u32 = 512;
pub const MAX_UUID_LEN: u32 = 64;
/// Teto por transação. Cada item escreve 3 entradas (registro, posição global e
/// posição no dono) e, com os 16 campos no máximo, perto de 5 KB. A rede hoje
/// aceita 200 entradas e 132 KB escritos por transação, mas o host de testes do
/// SDK ainda aplica o teto antigo de 50 escritas — e é ele que diz o que passa
/// no CI. 10 itens são 32 escritas no contrato, com folga para o nonce da conta,
/// o histórico da policy e a instância.
pub const MAX_BATCH: u32 = 10;
/// Teto de leitura por página de `records_of` (1 entrada lida por item), para
/// caber no teto de 100 entradas de footprint.
pub const MAX_PAGE: u32 = 50;
/// Teto de `page`: cada item lê 2 entradas (posição global e registro).
pub const MAX_RECORD_PAGE: u32 = 40;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LedgerError {
    TooManyFields = 6100,
    NameInvalid = 6101,
    UriInvalid = 6102,
    FieldKeyInvalid = 6103,
    FieldValueInvalid = 6104,
    /// UUID não existe no invent\u{e1}rio.
    RecordNotFound = 6105,
    /// UUID vazio ou maior que MAX_UUID_LEN.
    UuidInvalid = 6106,
    /// Já existe item com este UUID.
    UuidTaken = 6107,
    /// Lote vazio ou acima de MAX_BATCH.
    BatchInvalid = 6108,
    /// Transferência para o dono atual.
    SelfTransfer = 6109,
    /// A conta não está na allowlist de quem pode mintar.
    NotMinter = 6110,
}

/// Um item do invent\u{e1}rio.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Record {
    /// Identificador vindo de fora da chain — a mesma chave do banco do
    /// sistema consumidor.
    pub uuid: String,
    /// Dono atual. Muda a cada `transfer`.
    pub owner: Address,
    /// Quem mintou. Não muda — serve para saber de qual tenant o item saiu.
    pub minter: Address,
    pub name: String,
    pub uri: String,
    pub fields: Map<String, String>,
    pub minted_at: u64,
    pub minted_ledger: u32,
    /// Quantas vezes o item trocou de dono.
    pub transfers: u32,
    /// Ledger da última troca (0 se nunca trocou).
    pub last_transfer_ledger: u32,
    /// Posição do item na lista do dono atual (`OwnedAt(owner, idx)`). É o que
    /// deixa o `transfer` tirar o item do dono sem varrer a lista.
    pub owner_idx: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Item por UUID.
    Record(String),
    /// Posição global (ordem de emissão) -> UUID.
    AllAt(u32),
    /// Dono -> quantos itens tem.
    OwnedCount(Address),
    /// (dono, posição) -> UUID.
    OwnedAt(Address, u32),
    /// Total emitido (instance).
    Supply,
    /// Chave fria: troca o registrar e faz upgrade (instance).
    Admin,
    /// Chave operacional: mantém a allowlist de minters (instance).
    Registrar,
    /// Allowlist de minters (instance).
    Minter(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Minted {
    #[topic]
    pub minter: Address,
    #[topic]
    pub uuid: String,
    pub name: String,
    pub field_count: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transferred {
    #[topic]
    pub uuid: String,
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub transfers: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MinterUpdated {
    #[topic]
    pub minter: Address,
    pub allowed: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleUpdated {
    #[topic]
    pub role: soroban_sdk::Symbol,
    pub account: Address,
}

fn validate_metadata(e: &Env, name: &String, uri: &String, fields: &Map<String, String>) {
    if name.len() == 0 || name.len() > MAX_NAME_LEN {
        panic_with_error!(e, LedgerError::NameInvalid);
    }
    if uri.len() > MAX_URI_LEN {
        panic_with_error!(e, LedgerError::UriInvalid);
    }
    if fields.len() > MAX_FIELDS {
        panic_with_error!(e, LedgerError::TooManyFields);
    }
    for (key, value) in fields.iter() {
        if key.len() == 0 || key.len() > MAX_KEY_LEN {
            panic_with_error!(e, LedgerError::FieldKeyInvalid);
        }
        if value.len() > MAX_VALUE_LEN {
            panic_with_error!(e, LedgerError::FieldValueInvalid);
        }
    }
}

fn validate_uuid(e: &Env, uuid: &String) {
    if uuid.len() == 0 || uuid.len() > MAX_UUID_LEN {
        panic_with_error!(e, LedgerError::UuidInvalid);
    }
}

fn extend(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, RECORD_TTL_THRESHOLD, RECORD_TTL);
}

/// A instância guarda Supply, os papéis e a allowlist. Sem renovar, ela
/// arquiva e o contrato inteiro para de responder até alguém restaurar.
fn extend_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(RECORD_TTL_THRESHOLD, RECORD_TTL);
}

fn set_persistent<V>(e: &Env, key: &DataKey, value: &V)
where
    V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    e.storage().persistent().set(key, value);
    extend(e, key);
}

fn owned_count(e: &Env, owner: &Address) -> u32 {
    e.storage()
        .persistent()
        .get(&DataKey::OwnedCount(owner.clone()))
        .unwrap_or(0)
}

fn write_record(e: &Env, record: &Record) {
    set_persistent(e, &DataKey::Record(record.uuid.clone()), record);
}

fn read_record(e: &Env, uuid: &String) -> Record {
    e.storage()
        .persistent()
        .get(&DataKey::Record(uuid.clone()))
        .unwrap_or_else(|| panic_with_error!(e, LedgerError::RecordNotFound))
}

fn admin_of(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

fn registrar_of(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Registrar).unwrap()
}

fn require_minter(e: &Env, owner: &Address) {
    owner.require_auth();
    let allowed: bool = e
        .storage()
        .instance()
        .get(&DataKey::Minter(owner.clone()))
        .unwrap_or(false);
    if !allowed {
        panic_with_error!(e, LedgerError::NotMinter);
    }
}

/// Minta `uuids` para `owner`. Lê e grava os contadores uma vez só por chamada:
/// num lote, o que cresce por item são só as 3 entradas do próprio item.
fn mint_many(
    e: &Env,
    owner: &Address,
    uuids: &Vec<String>,
    name: &String,
    uri: &String,
    fields: &Map<String, String>,
) {
    let mut supply: u32 = e.storage().instance().get(&DataKey::Supply).unwrap_or(0);
    let mut owned = owned_count(e, owner);

    for uuid in uuids.iter() {
        validate_uuid(e, &uuid);
        if e.storage()
            .persistent()
            .has(&DataKey::Record(uuid.clone()))
        {
            panic_with_error!(e, LedgerError::UuidTaken);
        }

        write_record(
            e,
            &Record {
                uuid: uuid.clone(),
                owner: owner.clone(),
                minter: owner.clone(),
                name: name.clone(),
                uri: uri.clone(),
                fields: fields.clone(),
                minted_at: e.ledger().timestamp(),
                minted_ledger: e.ledger().sequence(),
                transfers: 0,
                last_transfer_ledger: 0,
                owner_idx: owned,
            },
        );
        set_persistent(e, &DataKey::AllAt(supply), &uuid);
        set_persistent(e, &DataKey::OwnedAt(owner.clone(), owned), &uuid);
        supply += 1;
        owned += 1;

        Minted {
            minter: owner.clone(),
            uuid,
            name: name.clone(),
            field_count: fields.len(),
        }
        .publish(e);
    }

    set_persistent(e, &DataKey::OwnedCount(owner.clone()), &owned);
    e.storage().instance().set(&DataKey::Supply, &supply);
    extend_instance(e);
}

#[contract]
pub struct DemoLedger;

#[contractimpl]
impl DemoLedger {
    /// `admin` é a chave fria (upgrade e troca do registrar); `registrar` é a
    /// chave operacional do serviço, que habilita a conta mestre de cada tenant
    /// no provisionamento.
    pub fn __constructor(e: &Env, admin: Address, registrar: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Registrar, &registrar);
        extend_instance(e);
    }

    /// Minta um item.
    ///
    /// `owner.require_auth()` é o que amarra o contrato à abstração de conta:
    /// quando o owner é uma smart account, a autorização passa pelo
    /// `__check_auth` dela — e, se a regra que assinou tiver a mint-quota
    /// policy instalada, o teto de itens do tenant é aplicado aqui, on-chain.
    pub fn mint(
        e: &Env,
        owner: Address,
        uuid: String,
        name: String,
        uri: String,
        fields: Map<String, String>,
    ) {
        require_minter(e, &owner);
        validate_metadata(e, &name, &uri, &fields);
        let mut one = Vec::new(e);
        one.push_back(uuid);
        mint_many(e, &owner, &one, &name, &uri, &fields);
    }

    /// Minta um lote com metadados compartilhados, um item por UUID.
    ///
    /// É como um invent\u{e1}rio de 10.000 itens é criado: o chamador repete esta
    /// função em lotes de até `MAX_BATCH`, porque uma transação Soroban tem
    /// limite de recursos.
    pub fn mint_batch(
        e: &Env,
        owner: Address,
        uuids: Vec<String>,
        name: String,
        uri: String,
        fields: Map<String, String>,
    ) -> u32 {
        require_minter(e, &owner);

        if uuids.len() == 0 || uuids.len() > MAX_BATCH {
            panic_with_error!(e, LedgerError::BatchInvalid);
        }
        validate_metadata(e, &name, &uri, &fields);
        mint_many(e, &owner, &uuids, &name, &uri, &fields);
        uuids.len()
    }

    /// Passa a posse de um item. É a venda do marketplace.
    ///
    /// Exige auth do dono atual — a conta mestre do tenant, enquanto o item
    /// está no invent\u{e1}rio; o comprador, depois.
    ///
    /// A saída da lista do dono é por troca com o último: o último item passa
    /// a ocupar a posição do que saiu. A ordem da lista de um dono não é
    /// estável; a ordem global (`page`) é.
    pub fn transfer(e: &Env, uuid: String, to: Address) {
        let mut record = read_record(e, &uuid);
        record.owner.require_auth();

        if record.owner == to {
            panic_with_error!(e, LedgerError::SelfTransfer);
        }

        let from = record.owner.clone();
        let last = owned_count(e, &from) - 1;
        if record.owner_idx != last {
            let moved_uuid: String = e
                .storage()
                .persistent()
                .get(&DataKey::OwnedAt(from.clone(), last))
                .unwrap();
            let mut moved = read_record(e, &moved_uuid);
            moved.owner_idx = record.owner_idx;
            write_record(e, &moved);
            set_persistent(e, &DataKey::OwnedAt(from.clone(), record.owner_idx), &moved_uuid);
        }
        e.storage()
            .persistent()
            .remove(&DataKey::OwnedAt(from.clone(), last));
        set_persistent(e, &DataKey::OwnedCount(from.clone()), &last);

        let to_idx = owned_count(e, &to);
        set_persistent(e, &DataKey::OwnedAt(to.clone(), to_idx), &uuid);
        set_persistent(e, &DataKey::OwnedCount(to.clone()), &(to_idx + 1));

        record.owner = to.clone();
        record.owner_idx = to_idx;
        record.transfers += 1;
        record.last_transfer_ledger = e.ledger().sequence();
        write_record(e, &record);
        extend_instance(e);

        Transferred {
            uuid,
            from,
            to,
            transfers: record.transfers,
        }
        .publish(e);
    }

    // --- papéis ---------------------------------------------------------

    /// Habilita ou desabilita uma conta para mintar. Só o registrar.
    pub fn set_minter(e: &Env, minter: Address, allowed: bool) {
        registrar_of(e).require_auth();
        let key = DataKey::Minter(minter.clone());
        if allowed {
            e.storage().instance().set(&key, &true);
        } else {
            e.storage().instance().remove(&key);
        }
        extend_instance(e);
        MinterUpdated { minter, allowed }.publish(e);
    }

    pub fn is_minter(e: &Env, account: Address) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Minter(account))
            .unwrap_or(false)
    }

    pub fn set_registrar(e: &Env, registrar: Address) {
        admin_of(e).require_auth();
        e.storage().instance().set(&DataKey::Registrar, &registrar);
        extend_instance(e);
        RoleUpdated {
            role: soroban_sdk::Symbol::new(e, "registrar"),
            account: registrar,
        }
        .publish(e);
    }

    pub fn set_admin(e: &Env, admin: Address) {
        admin_of(e).require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        extend_instance(e);
        RoleUpdated {
            role: soroban_sdk::Symbol::new(e, "admin"),
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

    pub fn get_record(e: &Env, uuid: String) -> Record {
        read_record(e, &uuid)
    }

    pub fn owner_of(e: &Env, uuid: String) -> Address {
        read_record(e, &uuid).owner
    }

    pub fn exists(e: &Env, uuid: String) -> bool {
        e.storage().persistent().has(&DataKey::Record(uuid))
    }

    /// Um campo específico, sem trazer o mapa inteiro.
    pub fn get_field(e: &Env, uuid: String, key: String) -> Option<String> {
        let record: Record = e.storage().persistent().get(&DataKey::Record(uuid))?;
        record.fields.get(key)
    }

    pub fn total_supply(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::Supply).unwrap_or(0)
    }

    pub fn balance_of(e: &Env, owner: Address) -> u32 {
        owned_count(e, &owner)
    }

    /// Página de UUIDs em posse de uma conta. `limit` é clampado em
    /// `MAX_PAGE`; `start` além do total devolve vazio.
    pub fn records_of(e: &Env, owner: Address, start: u32, limit: u32) -> Vec<String> {
        let total = owned_count(e, &owner);
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
            if let Some(uuid) = e
                .storage()
                .persistent()
                .get::<_, String>(&DataKey::OwnedAt(owner.clone(), idx))
            {
                out.push_back(uuid);
            }
        }
        out
    }

    /// Página do ledger, do mais recente para o mais antigo.
    pub fn page(e: &Env, offset: u32, limit: u32) -> Vec<Record> {
        let total: u32 = e.storage().instance().get(&DataKey::Supply).unwrap_or(0);
        let mut out = Vec::new(e);
        if offset >= total {
            return out;
        }

        let capped = if limit > MAX_RECORD_PAGE {
            MAX_RECORD_PAGE
        } else {
            limit
        };
        let mut taken = 0u32;
        let mut cursor = total - offset;

        while cursor > 0 && taken < capped {
            cursor -= 1;
            let Some(uuid) = e
                .storage()
                .persistent()
                .get::<_, String>(&DataKey::AllAt(cursor))
            else {
                continue;
            };
            if let Some(record) = e
                .storage()
                .persistent()
                .get::<_, Record>(&DataKey::Record(uuid))
            {
                out.push_back(record);
                taken += 1;
            }
        }

        out
    }
}

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
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Map, String, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const RECORD_TTL: u32 = 90 * DAY_IN_LEDGERS;
const RECORD_TTL_THRESHOLD: u32 = RECORD_TTL - DAY_IN_LEDGERS;

pub const MAX_FIELDS: u32 = 16;
pub const MAX_KEY_LEN: u32 = 32;
pub const MAX_VALUE_LEN: u32 = 256;
pub const MAX_NAME_LEN: u32 = 64;
pub const MAX_URI_LEN: u32 = 512;
pub const MAX_UUID_LEN: u32 = 64;
/// Teto por transação. 10.000 itens saem em lotes, não numa chamada só —
/// Soroban tem limite de recursos por transação.
pub const MAX_BATCH: u32 = 100;

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
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Item por UUID.
    Record(String),
    /// UUIDs em posse de uma conta.
    Owned(Address),
    /// Todos os UUIDs, em ordem de emissão.
    All,
    /// Total emitido.
    Supply,
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

fn push_owned(e: &Env, owner: &Address, uuid: &String) {
    let key = DataKey::Owned(owner.clone());
    let mut owned: Vec<String> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    owned.push_back(uuid.clone());
    e.storage().persistent().set(&key, &owned);
    extend(e, &key);
}

fn remove_owned(e: &Env, owner: &Address, uuid: &String) {
    let key = DataKey::Owned(owner.clone());
    let owned: Vec<String> = e.storage().persistent().get(&key).unwrap_or(Vec::new(e));
    let mut kept = Vec::new(e);
    for entry in owned.iter() {
        if entry != *uuid {
            kept.push_back(entry);
        }
    }
    e.storage().persistent().set(&key, &kept);
    extend(e, &key);
}

fn write_record(e: &Env, record: &Record) {
    let key = DataKey::Record(record.uuid.clone());
    e.storage().persistent().set(&key, record);
    extend(e, &key);
}

fn read_record(e: &Env, uuid: &String) -> Record {
    e.storage()
        .persistent()
        .get(&DataKey::Record(uuid.clone()))
        .unwrap_or_else(|| panic_with_error!(e, LedgerError::RecordNotFound))
}

fn mint_one(
    e: &Env,
    owner: &Address,
    uuid: String,
    name: &String,
    uri: &String,
    fields: &Map<String, String>,
) {
    validate_uuid(e, &uuid);
    if e.storage()
        .persistent()
        .has(&DataKey::Record(uuid.clone()))
    {
        panic_with_error!(e, LedgerError::UuidTaken);
    }

    let record = Record {
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
    };
    write_record(e, &record);
    push_owned(e, owner, &uuid);

    let mut all: Vec<String> = e
        .storage()
        .persistent()
        .get(&DataKey::All)
        .unwrap_or(Vec::new(e));
    all.push_back(uuid.clone());
    e.storage().persistent().set(&DataKey::All, &all);
    extend(e, &DataKey::All);

    let supply: u32 = e.storage().instance().get(&DataKey::Supply).unwrap_or(0);
    e.storage().instance().set(&DataKey::Supply, &(supply + 1));

    Minted {
        minter: owner.clone(),
        uuid,
        name: name.clone(),
        field_count: fields.len(),
    }
    .publish(e);
}

#[contract]
pub struct DemoLedger;

#[contractimpl]
impl DemoLedger {
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
        owner.require_auth();
        validate_metadata(e, &name, &uri, &fields);
        mint_one(e, &owner, uuid, &name, &uri, &fields);
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
        owner.require_auth();

        if uuids.len() == 0 || uuids.len() > MAX_BATCH {
            panic_with_error!(e, LedgerError::BatchInvalid);
        }
        validate_metadata(e, &name, &uri, &fields);

        for uuid in uuids.iter() {
            mint_one(e, &owner, uuid, &name, &uri, &fields);
        }
        uuids.len()
    }

    /// Passa a posse de um item. É a venda do marketplace.
    ///
    /// Exige auth do dono atual — a conta mestre do tenant, enquanto o item
    /// está no invent\u{e1}rio; o comprador, depois.
    pub fn transfer(e: &Env, uuid: String, to: Address) {
        let mut record = read_record(e, &uuid);
        record.owner.require_auth();

        if record.owner == to {
            panic_with_error!(e, LedgerError::SelfTransfer);
        }

        let from = record.owner.clone();
        remove_owned(e, &from, &uuid);
        push_owned(e, &to, &uuid);

        record.owner = to.clone();
        record.transfers += 1;
        record.last_transfer_ledger = e.ledger().sequence();
        write_record(e, &record);

        Transferred {
            uuid,
            from,
            to,
            transfers: record.transfers,
        }
        .publish(e);
    }

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

    /// UUIDs em posse de uma conta.
    pub fn records_of(e: &Env, owner: Address) -> Vec<String> {
        e.storage()
            .persistent()
            .get(&DataKey::Owned(owner))
            .unwrap_or(Vec::new(e))
    }

    pub fn balance_of(e: &Env, owner: Address) -> u32 {
        Self::records_of(e, owner).len()
    }

    /// Página do ledger, do mais recente para o mais antigo.
    pub fn page(e: &Env, offset: u32, limit: u32) -> Vec<Record> {
        let all: Vec<String> = e
            .storage()
            .persistent()
            .get(&DataKey::All)
            .unwrap_or(Vec::new(e));

        let total = all.len();
        let mut out = Vec::new(e);
        if offset >= total {
            return out;
        }

        let capped = if limit > 50 { 50 } else { limit };
        let mut taken = 0u32;
        let mut cursor = total - offset;

        while cursor > 0 && taken < capped {
            cursor -= 1;
            let uuid = all.get(cursor).unwrap();
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

//! # Demo Ledger — mint de NFT com campos livres
//!
//! Contrato de POC: registra um item (um "NFT") com metadados fixos e um mapa
//! de **campos customizados definidos por quem minta**. Cada mint vira uma
//! entrada imutável, numerada e com evento — é o "ledger" que a interface
//! mostra.
//!
//! O ponto do contrato neste projeto não é ser um cw721 completo, e sim
//! fechar o circuito da abstração de conta: o `owner.require_auth()` aqui
//! obriga a smart account a passar pelo `__check_auth` (passkey ou session
//! key), a transação é submetida pelo relayer patrocinado e o custo é debitado
//! no Treasury. O mint é o pretexto; a prova é que o usuário nunca tocou em
//! XLM nem em seed phrase.
//!
//! Os limites de tamanho são deliberados: campo livre sem teto vira transação
//! cara e imprevisível, e quem paga a fee é o sponsor, não quem minta.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Map, String, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const RECORD_TTL: u32 = 90 * DAY_IN_LEDGERS;
const RECORD_TTL_THRESHOLD: u32 = RECORD_TTL - DAY_IN_LEDGERS;

/// Tetos do mint. Existem porque a fee é patrocinada: sem limite, um campo
/// gigante viraria custo do sponsor.
pub const MAX_FIELDS: u32 = 16;
pub const MAX_KEY_LEN: u32 = 32;
pub const MAX_VALUE_LEN: u32 = 256;
pub const MAX_NAME_LEN: u32 = 64;
pub const MAX_URI_LEN: u32 = 512;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LedgerError {
    /// Mais campos customizados do que o contrato aceita.
    TooManyFields = 6100,
    /// Nome vazio ou maior que MAX_NAME_LEN.
    NameInvalid = 6101,
    /// URI maior que MAX_URI_LEN.
    UriInvalid = 6102,
    /// Chave de campo vazia ou maior que MAX_KEY_LEN.
    FieldKeyInvalid = 6103,
    /// Valor de campo maior que MAX_VALUE_LEN.
    FieldValueInvalid = 6104,
    /// Registro inexistente.
    RecordNotFound = 6105,
}

/// Uma entrada do ledger. Imutável depois de criada.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Record {
    pub id: u32,
    /// Smart account que autorizou o mint.
    pub owner: Address,
    pub name: String,
    /// URI da mídia; pode ser vazia.
    pub uri: String,
    /// Campos livres definidos por quem minta.
    pub fields: Map<String, String>,
    /// Timestamp do ledger em que foi criado.
    pub minted_at: u64,
    /// Sequência do ledger — junto com o timestamp, dá para reconstruir a
    /// ordem exata dos mints sem depender de indexador.
    pub minted_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Próximo id a ser emitido.
    NextId,
    /// Registro por id.
    Record(u32),
    /// Ids emitidos por uma conta.
    Owned(Address),
    /// Ids emitidos, em ordem — a listagem do ledger.
    All,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Minted {
    #[topic]
    pub owner: Address,
    #[topic]
    pub id: u32,
    pub name: String,
    pub field_count: u32,
}

fn next_id(e: &Env) -> u32 {
    let id: u32 = e.storage().instance().get(&DataKey::NextId).unwrap_or(0);
    e.storage().instance().set(&DataKey::NextId, &(id + 1));
    id
}

fn validate(e: &Env, name: &String, uri: &String, fields: &Map<String, String>) {
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

#[contract]
pub struct DemoLedger;

#[contractimpl]
impl DemoLedger {
    /// Registra um item no ledger.
    ///
    /// `owner.require_auth()` é o que amarra este contrato à abstração de
    /// conta: quando o owner é uma smart account, a autorização passa pelo
    /// `__check_auth` dela — passkey na regra Default, ou uma session key
    /// numa regra `CallContract(este contrato)` com teto de gasto e prazo.
    ///
    /// # Arguments
    ///
    /// * `owner` - Conta que assina e fica como dona do registro.
    /// * `name` - Nome do item.
    /// * `uri` - URI da mídia; pode ser vazia.
    /// * `fields` - Campos customizados livres (até `MAX_FIELDS`).
    pub fn mint(
        e: &Env,
        owner: Address,
        name: String,
        uri: String,
        fields: Map<String, String>,
    ) -> u32 {
        owner.require_auth();
        validate(e, &name, &uri, &fields);

        let id = next_id(e);
        let field_count = fields.len();

        let record = Record {
            id,
            owner: owner.clone(),
            name: name.clone(),
            uri,
            fields,
            minted_at: e.ledger().timestamp(),
            minted_ledger: e.ledger().sequence(),
        };

        e.storage().persistent().set(&DataKey::Record(id), &record);
        e.storage().persistent().extend_ttl(
            &DataKey::Record(id),
            RECORD_TTL_THRESHOLD,
            RECORD_TTL,
        );

        let mut owned: Vec<u32> = e
            .storage()
            .persistent()
            .get(&DataKey::Owned(owner.clone()))
            .unwrap_or(Vec::new(e));
        owned.push_back(id);
        e.storage()
            .persistent()
            .set(&DataKey::Owned(owner.clone()), &owned);
        e.storage().persistent().extend_ttl(
            &DataKey::Owned(owner.clone()),
            RECORD_TTL_THRESHOLD,
            RECORD_TTL,
        );

        let mut all: Vec<u32> = e
            .storage()
            .persistent()
            .get(&DataKey::All)
            .unwrap_or(Vec::new(e));
        all.push_back(id);
        e.storage().persistent().set(&DataKey::All, &all);
        e.storage()
            .persistent()
            .extend_ttl(&DataKey::All, RECORD_TTL_THRESHOLD, RECORD_TTL);

        Minted {
            owner,
            id,
            name,
            field_count,
        }
        .publish(e);

        id
    }

    /// Registro por id.
    pub fn get_record(e: &Env, id: u32) -> Record {
        e.storage()
            .persistent()
            .get(&DataKey::Record(id))
            .unwrap_or_else(|| panic_with_error!(e, LedgerError::RecordNotFound))
    }

    /// Um campo específico de um registro. Evita trazer o mapa inteiro quando
    /// só um valor interessa.
    pub fn get_field(e: &Env, id: u32, key: String) -> Option<String> {
        let record: Record = e.storage().persistent().get(&DataKey::Record(id))?;
        record.fields.get(key)
    }

    /// Quantidade de registros já emitidos.
    pub fn total_supply(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }

    /// Ids emitidos por uma conta.
    pub fn records_of(e: &Env, owner: Address) -> Vec<u32> {
        e.storage()
            .persistent()
            .get(&DataKey::Owned(owner))
            .unwrap_or(Vec::new(e))
    }

    /// Página do ledger, do mais recente para o mais antigo.
    ///
    /// A paginação é obrigatória: `Vec` inteiro num contrato com muitos
    /// registros estoura o limite de leitura da simulação.
    pub fn page(e: &Env, offset: u32, limit: u32) -> Vec<Record> {
        let all: Vec<u32> = e
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
            let id = all.get(cursor).unwrap();
            if let Some(record) = e.storage().persistent().get::<_, Record>(&DataKey::Record(id)) {
                out.push_back(record);
                taken += 1;
            }
        }

        out
    }

    /// Chaves de campo usadas em um registro — útil para a interface montar a
    /// tabela sem adivinhar o formato.
    pub fn field_keys(e: &Env, id: u32) -> Vec<String> {
        let record: Record = Self::get_record(e, id);
        record.fields.keys()
    }

    /// Identificação do contrato, para a interface conferir que está falando
    /// com o ledger certo.
    pub fn name(e: &Env) -> Symbol {
        Symbol::new(e, "demo_ledger")
    }
}

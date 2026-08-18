#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, Map, String, Vec,
};
use std::string::ToString;

use crate::{DemoLedger, DemoLedgerClient, MAX_FIELDS};

fn setup() -> (Env, DemoLedgerClient<'static>, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(DemoLedger, ());
    let client = DemoLedgerClient::new(&e, &contract_id);
    let owner = Address::generate(&e);
    (e, client, owner)
}

fn fields(e: &Env, pairs: &[(&str, &str)]) -> Map<String, String> {
    let mut map = Map::new(e);
    for (key, value) in pairs {
        map.set(String::from_str(e, key), String::from_str(e, value));
    }
    map
}

#[test]
fn mint_registers_record_with_custom_fields() {
    let (e, client, owner) = setup();
    e.ledger().with_mut(|l| {
        l.timestamp = 1_800_000_000;
        l.sequence_number = 4242;
    });

    let custom = fields(
        &e,
        &[
            ("campanha", "Turnê 2026"),
            ("lote", "pista premium"),
            ("assento", "A12"),
        ],
    );

    let id = client.mint(
        &owner,
        &String::from_str(&e, "Ingresso VIP"),
        &String::from_str(&e, "ipfs://Qm123"),
        &custom,
    );
    assert_eq!(id, 0);

    let record = client.get_record(&id);
    assert_eq!(record.owner, owner);
    assert_eq!(record.name, String::from_str(&e, "Ingresso VIP"));
    assert_eq!(record.minted_at, 1_800_000_000);
    assert_eq!(record.minted_ledger, 4242);
    assert_eq!(record.fields.len(), 3);
    assert_eq!(
        record.fields.get(String::from_str(&e, "assento")),
        Some(String::from_str(&e, "A12"))
    );
}

#[test]
fn ids_are_sequential_and_indexed_by_owner() {
    let (e, client, owner) = setup();
    let other = Address::generate(&e);
    let empty = Map::new(&e);

    let first = client.mint(&owner, &String::from_str(&e, "A"), &String::from_str(&e, ""), &empty);
    let second = client.mint(&other, &String::from_str(&e, "B"), &String::from_str(&e, ""), &empty);
    let third = client.mint(&owner, &String::from_str(&e, "C"), &String::from_str(&e, ""), &empty);

    assert_eq!((first, second, third), (0, 1, 2));
    assert_eq!(client.total_supply(), 3);

    let owned = client.records_of(&owner);
    assert_eq!(owned, Vec::from_array(&e, [0, 2]));
    assert_eq!(client.records_of(&other), Vec::from_array(&e, [1]));
}

#[test]
fn page_lists_newest_first_and_respects_offset() {
    let (e, client, owner) = setup();
    let empty = Map::new(&e);
    for label in ["um", "dois", "tres", "quatro"] {
        client.mint(&owner, &String::from_str(&e, label), &String::from_str(&e, ""), &empty);
    }

    let first_page = client.page(&0, &2);
    assert_eq!(first_page.len(), 2);
    assert_eq!(first_page.get(0).unwrap().name, String::from_str(&e, "quatro"));
    assert_eq!(first_page.get(1).unwrap().name, String::from_str(&e, "tres"));

    let second_page = client.page(&2, &2);
    assert_eq!(second_page.get(0).unwrap().name, String::from_str(&e, "dois"));
    assert_eq!(second_page.get(1).unwrap().name, String::from_str(&e, "um"));

    // Offset além do fim devolve vazio em vez de estourar.
    assert_eq!(client.page(&99, &10).len(), 0);
}

#[test]
fn get_field_reads_a_single_value() {
    let (e, client, owner) = setup();
    let id = client.mint(
        &owner,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &fields(&e, &[("cor", "verde")]),
    );

    assert_eq!(
        client.get_field(&id, &String::from_str(&e, "cor")),
        Some(String::from_str(&e, "verde"))
    );
    assert_eq!(client.get_field(&id, &String::from_str(&e, "inexistente")), None);
}

#[test]
fn mint_requires_owner_auth() {
    let e = Env::default();
    let contract_id = e.register(DemoLedger, ());
    let client = DemoLedgerClient::new(&e, &contract_id);
    let owner = Address::generate(&e);

    // Sem mock_all_auths, o require_auth do owner precisa estar presente.
    let result = client.try_mint(
        &owner,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
    assert!(result.is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #6101)")]
fn empty_name_is_rejected() {
    let (e, client, owner) = setup();
    client.mint(
        &owner,
        &String::from_str(&e, ""),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6100)")]
fn too_many_fields_is_rejected() {
    let (e, client, owner) = setup();
    let mut map = Map::new(&e);
    for index in 0..=MAX_FIELDS {
        // Chaves distintas: "k0", "k1", … garantem que o mapa cresce mesmo.
        let mut key = std::string::String::from("k");
        key.push_str(&index.to_string());
        map.set(String::from_str(&e, &key), String::from_str(&e, "v"));
    }
    client.mint(
        &owner,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &map,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6103)")]
fn empty_field_key_is_rejected() {
    let (e, client, owner) = setup();
    client.mint(
        &owner,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &fields(&e, &[("", "valor")]),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6105)")]
fn unknown_record_panics() {
    let (_e, client, _owner) = setup();
    client.get_record(&99);
}

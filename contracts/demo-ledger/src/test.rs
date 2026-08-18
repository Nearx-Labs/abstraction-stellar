#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, Map, String, Vec,
};
use std::string::ToString;

use crate::{DemoLedger, DemoLedgerClient, MAX_BATCH, MAX_FIELDS};

fn setup() -> (Env, DemoLedgerClient<'static>, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let contract_id = e.register(DemoLedger, ());
    let client = DemoLedgerClient::new(&e, &contract_id);
    let master = Address::generate(&e);
    (e, client, master)
}

fn fields(e: &Env, pairs: &[(&str, &str)]) -> Map<String, String> {
    let mut map = Map::new(e);
    for (key, value) in pairs {
        map.set(String::from_str(e, key), String::from_str(e, value));
    }
    map
}

fn uuid(e: &Env, n: u32) -> String {
    let mut id = std::string::String::from("6f1c0b2e-0000-4000-8000-");
    id.push_str(&std::format!("{n:012}"));
    String::from_str(e, &id)
}

#[test]
fn mint_registers_the_item_under_its_uuid() {
    let (e, client, master) = setup();
    e.ledger().with_mut(|l| {
        l.timestamp = 1_800_000_000;
        l.sequence_number = 4242;
    });

    let id = uuid(&e, 1);
    client.mint(
        &master,
        &id,
        &String::from_str(&e, "Ingresso VIP"),
        &String::from_str(&e, "ipfs://Qm123"),
        &fields(
            &e,
            &[("campanha", "Turnê 2026"), ("lote", "pista"), ("assento", "A12")],
        ),
    );

    let record = client.get_record(&id);
    assert_eq!(record.uuid, id);
    assert_eq!(record.owner, master);
    assert_eq!(record.minter, master);
    assert_eq!(record.minted_at, 1_800_000_000);
    assert_eq!(record.minted_ledger, 4242);
    assert_eq!(record.transfers, 0);
    assert_eq!(
        record.fields.get(String::from_str(&e, "assento")),
        Some(String::from_str(&e, "A12"))
    );
    assert!(client.exists(&id));
    assert_eq!(client.total_supply(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #6107)")]
fn the_same_uuid_cannot_be_minted_twice() {
    let (e, client, master) = setup();
    let id = uuid(&e, 1);
    let empty = Map::new(&e);

    client.mint(&master, &id, &String::from_str(&e, "A"), &String::from_str(&e, ""), &empty);
    client.mint(&master, &id, &String::from_str(&e, "B"), &String::from_str(&e, ""), &empty);
}

#[test]
fn mint_batch_creates_the_whole_inventory_for_the_master() {
    let (e, client, master) = setup();

    let mut uuids = Vec::new(&e);
    for n in 0..25u32 {
        uuids.push_back(uuid(&e, n));
    }

    let minted = client.mint_batch(
        &master,
        &uuids,
        &String::from_str(&e, "Ingresso — Turnê 2026"),
        &String::from_str(&e, "ipfs://QmLote"),
        &fields(&e, &[("campanha", "turne-2026")]),
    );

    assert_eq!(minted, 25);
    assert_eq!(client.total_supply(), 25);
    assert_eq!(client.balance_of(&master), 25);
    // Metadados compartilhados chegam em cada item.
    assert_eq!(
        client.get_record(&uuid(&e, 7)).fields.get(String::from_str(&e, "campanha")),
        Some(String::from_str(&e, "turne-2026"))
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6108)")]
fn batch_above_the_cap_is_rejected() {
    let (e, client, master) = setup();
    let mut uuids = Vec::new(&e);
    for n in 0..=MAX_BATCH {
        uuids.push_back(uuid(&e, n));
    }
    client.mint_batch(
        &master,
        &uuids,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
}

#[test]
fn transfer_moves_ownership_and_both_indexes() {
    let (e, client, master) = setup();
    let buyer = Address::generate(&e);
    let id = uuid(&e, 1);
    let empty = Map::new(&e);

    client.mint(&master, &id, &String::from_str(&e, "Item"), &String::from_str(&e, ""), &empty);
    e.ledger().with_mut(|l| l.sequence_number = 9_000);

    client.transfer(&id, &buyer);

    let record = client.get_record(&id);
    assert_eq!(record.owner, buyer);
    // O minter não muda: é como se sabe de qual tenant o item saiu.
    assert_eq!(record.minter, master);
    assert_eq!(record.transfers, 1);
    assert_eq!(record.last_transfer_ledger, 9_000);

    assert_eq!(client.owner_of(&id), buyer);
    assert_eq!(client.balance_of(&master), 0);
    assert_eq!(client.balance_of(&buyer), 1);
    assert_eq!(client.records_of(&buyer), Vec::from_array(&e, [id]));
}

#[test]
fn item_can_change_hands_repeatedly() {
    let (e, client, master) = setup();
    let first = Address::generate(&e);
    let second = Address::generate(&e);
    let id = uuid(&e, 1);

    client.mint(
        &master,
        &id,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
    client.transfer(&id, &first);
    client.transfer(&id, &second);

    assert_eq!(client.owner_of(&id), second);
    assert_eq!(client.get_record(&id).transfers, 2);
    assert_eq!(client.balance_of(&first), 0);
    assert_eq!(client.balance_of(&second), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #6109)")]
fn transfer_to_the_current_owner_is_rejected() {
    let (e, client, master) = setup();
    let id = uuid(&e, 1);
    client.mint(
        &master,
        &id,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
    client.transfer(&id, &master);
}

#[test]
fn transfer_requires_the_current_owner_auth() {
    let e = Env::default();
    let contract_id = e.register(DemoLedger, ());
    let client = DemoLedgerClient::new(&e, &contract_id);
    let master = Address::generate(&e);
    let buyer = Address::generate(&e);
    let id = uuid(&e, 1);

    e.mock_all_auths();
    client.mint(
        &master,
        &id,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );

    // Sem auth mockada, a transferência precisa da assinatura do dono.
    e.set_auths(&[]);
    assert!(client.try_transfer(&id, &buyer).is_err());
}

#[test]
fn page_lists_newest_first() {
    let (e, client, master) = setup();
    let empty = Map::new(&e);
    for n in 0..4u32 {
        let mut label = std::string::String::from("item-");
        label.push_str(&n.to_string());
        client.mint(
            &master,
            &uuid(&e, n),
            &String::from_str(&e, &label),
            &String::from_str(&e, ""),
            &empty,
        );
    }

    let first = client.page(&0, &2);
    assert_eq!(first.len(), 2);
    assert_eq!(first.get(0).unwrap().uuid, uuid(&e, 3));
    assert_eq!(first.get(1).unwrap().uuid, uuid(&e, 2));

    let second = client.page(&2, &2);
    assert_eq!(second.get(0).unwrap().uuid, uuid(&e, 1));
    assert_eq!(client.page(&99, &10).len(), 0);
}

#[test]
fn get_field_reads_a_single_value() {
    let (e, client, master) = setup();
    let id = uuid(&e, 1);
    client.mint(
        &master,
        &id,
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &fields(&e, &[("cor", "verde")]),
    );

    assert_eq!(
        client.get_field(&id, &String::from_str(&e, "cor")),
        Some(String::from_str(&e, "verde"))
    );
    assert_eq!(client.get_field(&id, &String::from_str(&e, "nao-existe")), None);
}

#[test]
#[should_panic(expected = "Error(Contract, #6106)")]
fn empty_uuid_is_rejected() {
    let (e, client, master) = setup();
    client.mint(
        &master,
        &String::from_str(&e, ""),
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6101)")]
fn empty_name_is_rejected() {
    let (e, client, master) = setup();
    client.mint(
        &master,
        &uuid(&e, 1),
        &String::from_str(&e, ""),
        &String::from_str(&e, ""),
        &Map::new(&e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6100)")]
fn too_many_fields_is_rejected() {
    let (e, client, master) = setup();
    let mut map = Map::new(&e);
    for index in 0..=MAX_FIELDS {
        let mut key = std::string::String::from("k");
        key.push_str(&index.to_string());
        map.set(String::from_str(&e, &key), String::from_str(&e, "v"));
    }
    client.mint(
        &master,
        &uuid(&e, 1),
        &String::from_str(&e, "Item"),
        &String::from_str(&e, ""),
        &map,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6105)")]
fn unknown_uuid_panics() {
    let (e, client, _master) = setup();
    client.get_record(&uuid(&e, 999));
}

#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{storage::Instance as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, Map, String, Vec,
};
use std::string::ToString;

use crate::{DemoLedger, DemoLedgerClient, MAX_BATCH, MAX_FIELDS, MAX_PAGE, MAX_RECORD_PAGE};

struct Setup {
    e: Env,
    client: DemoLedgerClient<'static>,
    master: Address,
    admin: Address,
    registrar: Address,
}

fn deploy() -> Setup {
    let e = Env::default();
    let admin = Address::generate(&e);
    let registrar = Address::generate(&e);
    let contract_id = e.register(DemoLedger, (&admin, &registrar));
    let client = DemoLedgerClient::new(&e, &contract_id);
    let master = Address::generate(&e);
    Setup {
        e,
        client,
        master,
        admin,
        registrar,
    }
}

/// Contrato com a mestre já habilitada e auth mockada — o caso comum.
fn setup() -> (Env, DemoLedgerClient<'static>, Address) {
    let s = deploy();
    s.e.mock_all_auths();
    s.client.set_minter(&s.master, &true);
    (s.e, s.client, s.master)
}

fn mint_n(e: &Env, client: &DemoLedgerClient, owner: &Address, from: u32, count: u32) {
    let mut start = from;
    let end = from + count;
    while start < end {
        let stop = (start + MAX_BATCH).min(end);
        let mut uuids = Vec::new(e);
        for n in start..stop {
            uuids.push_back(uuid(e, n));
        }
        client.mint_batch(
            owner,
            &uuids,
            &String::from_str(e, "Item"),
            &String::from_str(e, ""),
            &fields(e, &[("campaignId", "c-1")]),
        );
        start = stop;
    }
}

fn all_owned(client: &DemoLedgerClient, owner: &Address) -> std::vec::Vec<std::string::String> {
    let mut out = std::vec::Vec::new();
    let mut start = 0u32;
    loop {
        let page = client.records_of(owner, &start, &MAX_PAGE);
        if page.len() == 0 {
            break;
        }
        for id in page.iter() {
            out.push(id.to_string());
        }
        start += page.len();
    }
    out
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
    for n in 0..MAX_BATCH {
        uuids.push_back(uuid(&e, n));
    }

    let minted = client.mint_batch(
        &master,
        &uuids,
        &String::from_str(&e, "Ingresso — Turnê 2026"),
        &String::from_str(&e, "ipfs://QmLote"),
        &fields(&e, &[("campanha", "turne-2026")]),
    );

    assert_eq!(minted, MAX_BATCH);
    assert_eq!(client.total_supply(), MAX_BATCH);
    assert_eq!(client.balance_of(&master), MAX_BATCH);
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
    assert_eq!(client.records_of(&buyer, &0, &10), Vec::from_array(&e, [id]));
    assert_eq!(client.records_of(&master, &0, &10).len(), 0);
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
    let Setup { e, client, master, .. } = deploy();
    let buyer = Address::generate(&e);
    let id = uuid(&e, 1);

    e.mock_all_auths();
    client.set_minter(&master, &true);
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

// --- allowlist, papéis e upgrade ---------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #6110)")]
fn an_account_outside_the_allowlist_cannot_mint() {
    let s = deploy();
    s.e.mock_all_auths();
    // Sem set_minter: é o caso de quem tenta mintar o UUID do consumidor antes.
    s.client.mint(
        &s.master,
        &uuid(&s.e, 1),
        &String::from_str(&s.e, "Item"),
        &String::from_str(&s.e, ""),
        &Map::new(&s.e),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6110)")]
fn a_revoked_minter_cannot_mint_batch() {
    let (e, client, master) = setup();
    client.set_minter(&master, &false);
    mint_n(&e, &client, &master, 0, 1);
}

#[test]
fn only_the_registrar_manages_the_allowlist() {
    let s = deploy();
    let intruder = Address::generate(&s.e);

    // Assinado pelo intruso, não pelo registrar: recusa.
    let denied = s
        .client
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "set_minter",
                args: (&intruder, true).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .try_set_minter(&intruder, &true);
    assert!(denied.is_err());
    assert!(!s.client.is_minter(&intruder));

    s.client
        .mock_auths(&[MockAuth {
            address: &s.registrar,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "set_minter",
                args: (&s.master, true).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .set_minter(&s.master, &true);
    assert!(s.client.is_minter(&s.master));
}

#[test]
fn the_registrar_cannot_upgrade_or_change_roles() {
    let s = deploy();
    let hash = BytesN::from_array(&s.e, &[7u8; 32]);

    let upgrade = s
        .client
        .mock_auths(&[MockAuth {
            address: &s.registrar,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "upgrade",
                args: (&hash,).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&hash);
    assert!(upgrade.is_err());

    let other = Address::generate(&s.e);
    let swap = s
        .client
        .mock_auths(&[MockAuth {
            address: &s.registrar,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "set_registrar",
                args: (&other,).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .try_set_registrar(&other);
    assert!(swap.is_err());
    assert_eq!(s.client.registrar(), s.registrar);
}

#[test]
fn the_admin_rotates_the_registrar() {
    let s = deploy();
    let next = Address::generate(&s.e);
    s.client
        .mock_auths(&[MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.client.address,
                fn_name: "set_registrar",
                args: (&next,).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .set_registrar(&next);
    assert_eq!(s.client.registrar(), next);
    assert_eq!(s.client.admin(), s.admin);
}

// --- escala e consistência dos índices -----------------------------------

#[test]
fn two_thousand_items_mint_and_paginate_without_hitting_an_entry_limit() {
    let (e, client, master) = setup();
    e.cost_estimate().budget().reset_unlimited();

    mint_n(&e, &client, &master, 0, 2_000);

    assert_eq!(client.total_supply(), 2_000);
    assert_eq!(client.balance_of(&master), 2_000);

    let owned = all_owned(&client, &master);
    assert_eq!(owned.len(), 2_000);
    let mut sorted = owned.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 2_000, "records_of repetiu ou perdeu item");

    // page varre o inventário inteiro, do mais novo para o mais velho.
    let mut seen = 0u32;
    let mut offset = 0u32;
    loop {
        let page = client.page(&offset, &MAX_RECORD_PAGE);
        if page.len() == 0 {
            break;
        }
        if offset == 0 {
            assert_eq!(page.get(0).unwrap().uuid, uuid(&e, 1_999));
        }
        seen += page.len();
        offset += page.len();
    }
    assert_eq!(seen, 2_000);
}

#[test]
fn a_mint_costs_the_same_at_item_one_and_at_item_two_thousand() {
    let (e, client, master) = setup();
    e.cost_estimate().budget().reset_unlimited();

    mint_n(&e, &client, &master, 0, MAX_BATCH);
    let early = e.cost_estimate().resources().write_bytes;

    mint_n(&e, &client, &master, MAX_BATCH, 2_000 - MAX_BATCH * 2);
    mint_n(&e, &client, &master, 2_000 - MAX_BATCH, MAX_BATCH);
    let late = e.cost_estimate().resources().write_bytes;

    // Na versão com Vec único, o lote tardio escrevia o inventário inteiro
    // (~90 KB). Aqui escreve só os itens do lote.
    assert!(late <= early + 64, "write_bytes cresceu: {early} -> {late}");
}

#[test]
fn transferring_an_item_from_the_middle_keeps_both_owner_lists_consistent() {
    let (e, client, master) = setup();
    let buyer = Address::generate(&e);
    mint_n(&e, &client, &master, 0, 5);

    // Tira o do meio, depois o primeiro, depois o último que restou.
    client.transfer(&uuid(&e, 2), &buyer);
    client.transfer(&uuid(&e, 0), &buyer);

    let mut master_items = all_owned(&client, &master);
    master_items.sort();
    let expected: std::vec::Vec<std::string::String> =
        [1u32, 3, 4].iter().map(|n| uuid(&e, *n).to_string()).collect();
    assert_eq!(master_items, expected);
    assert_eq!(client.balance_of(&master), 3);

    let mut buyer_items = all_owned(&client, &buyer);
    buyer_items.sort();
    assert_eq!(
        buyer_items,
        std::vec![uuid(&e, 0).to_string(), uuid(&e, 2).to_string()]
    );

    // owner_idx de cada registro aponta de volta para a posição certa.
    for (owner, items) in [(&master, &master_items), (&buyer, &buyer_items)] {
        for id in items.iter() {
            let record = client.get_record(&String::from_str(&e, id));
            let at = client.records_of(owner, &record.owner_idx, &1);
            assert_eq!(at.get(0).unwrap().to_string(), *id);
        }
    }

    // O comprador revende um item: a lista dele encolhe sem buraco.
    let third = Address::generate(&e);
    client.transfer(&uuid(&e, 0), &third);
    assert_eq!(all_owned(&client, &buyer), std::vec![uuid(&e, 2).to_string()]);
    assert_eq!(all_owned(&client, &third), std::vec![uuid(&e, 0).to_string()]);
}

#[test]
fn records_of_pages_are_clamped_and_past_the_end_is_empty() {
    let (e, client, master) = setup();
    mint_n(&e, &client, &master, 0, MAX_PAGE + 10);
    assert_eq!(client.records_of(&master, &0, &1_000).len(), MAX_PAGE);
    assert_eq!(client.records_of(&master, &MAX_PAGE, &MAX_PAGE).len(), 10);
    assert_eq!(client.records_of(&master, &999, &10).len(), 0);
}

#[test]
fn minting_extends_the_instance_ttl() {
    let (e, client, master) = setup();
    let before = e.as_contract(&client.address, || e.storage().instance().get_ttl());
    e.ledger().with_mut(|l| l.sequence_number += 1_000_000);
    mint_n(&e, &client, &master, 0, 1);
    let after = e.as_contract(&client.address, || e.storage().instance().get_ttl());
    assert!(after > before.saturating_sub(1_000_000), "instância não foi renovada");
    assert!(after >= 119 * 17_280, "TTL abaixo do alvo: {after}");
}

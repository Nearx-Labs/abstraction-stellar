#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String, Symbol,
};

use crate::{AnchorLedger, AnchorLedgerClient, MAX_PAGE, MAX_TENANT_LEN};

fn setup() -> (Env, AnchorLedgerClient<'static>, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let id = e.register(AnchorLedger, ());
    let client = AnchorLedgerClient::new(&e, &id);
    let master = Address::generate(&e);
    (e, client, master)
}

fn hash(e: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(e, &[byte; 32])
}

fn text(e: &Env, value: &str) -> String {
    String::from_str(e, value)
}

fn long(e: &Env, len: usize) -> String {
    let filled = std::string::String::from_utf8(std::vec![b'a'; len]).unwrap();
    String::from_str(e, &filled)
}

#[test]
fn register_increments_seq_and_indexes_by_tenant() {
    let (e, client, master) = setup();
    e.ledger().with_mut(|l| {
        l.timestamp = 1_800_000_000;
        l.sequence_number = 4242;
    });

    let tenant = text(&e, "11111111-1111-1111-1111-111111111111");

    let seq0 = client.register(
        &master,
        &tenant,
        &Symbol::new(&e, "credit_purchase"),
        &text(&e, "tx-1"),
        &hash(&e, 1),
        &1i128,
    );
    let seq1 = client.register(
        &master,
        &tenant,
        &Symbol::new(&e, "marketplace_transfer"),
        &text(&e, "listing-9"),
        &hash(&e, 2),
        &4500i128,
    );

    assert_eq!(seq0, 0);
    assert_eq!(seq1, 1);
    assert_eq!(client.total_records(), 2);
    assert_eq!(client.tenant_count(&tenant), 2);
    assert_eq!(client.tenants().len(), 1);

    let rec = client.get_record(&1);
    assert_eq!(rec.reference, text(&e, "listing-9"));
    assert_eq!(rec.kind, Symbol::new(&e, "marketplace_transfer"));
    assert_eq!(rec.payload_hash, hash(&e, 2));
    assert_eq!(rec.amount, 4500i128);
    assert_eq!(rec.tenant_id, tenant);
    assert_eq!(rec.writer, master);
    assert_eq!(rec.timestamp, 1_800_000_000);
    assert_eq!(rec.ledger, 4242);
}

#[test]
fn two_tenants_are_isolated() {
    let (e, client, master) = setup();

    let a = text(&e, "tenant-a");
    let b = text(&e, "tenant-b");
    let kind = Symbol::new(&e, "web2_purchase");

    client.register(&master, &a, &kind, &text(&e, "a-1"), &hash(&e, 1), &1);
    client.register(&master, &b, &kind, &text(&e, "b-1"), &hash(&e, 2), &2);
    client.register(&master, &a, &kind, &text(&e, "a-2"), &hash(&e, 3), &3);

    assert_eq!(client.tenant_count(&a), 2);
    assert_eq!(client.tenant_count(&b), 1);
    assert_eq!(client.tenants().len(), 2);
    assert_eq!(client.total_records(), 3);

    let recs_a = client.tenant_records(&a, &0, &10);
    assert_eq!(recs_a.len(), 2);
    assert_eq!(recs_a.get(0).unwrap().reference, text(&e, "a-1"));
    assert_eq!(recs_a.get(1).unwrap().reference, text(&e, "a-2"));
}

/// Duas contas mestre diferentes escrevendo no mesmo contrato: o `writer`
/// distingue quem assinou, e o índice por tenant não se mistura.
#[test]
fn writer_records_which_master_signed() {
    let (e, client, master_a) = setup();
    let master_b = Address::generate(&e);
    let kind = Symbol::new(&e, "refund");

    client.register(&master_a, &text(&e, "t-a"), &kind, &text(&e, "r-1"), &hash(&e, 1), &1);
    client.register(&master_b, &text(&e, "t-b"), &kind, &text(&e, "r-2"), &hash(&e, 2), &1);

    assert_eq!(client.get_record(&0).writer, master_a);
    assert_eq!(client.get_record(&1).writer, master_b);
}

#[test]
fn tenant_records_paging() {
    let (e, client, master) = setup();

    let tenant = text(&e, "tenant-page");
    let kind = Symbol::new(&e, "credit_lock");
    for i in 0..5u8 {
        client.register(&master, &tenant, &kind, &text(&e, "ref"), &hash(&e, i), &(i as i128));
    }

    assert_eq!(client.tenant_records(&tenant, &0, &2).len(), 2);
    assert_eq!(client.tenant_records(&tenant, &3, &10).len(), 2);
    // start além do total devolve vazio em vez de estourar
    assert_eq!(client.tenant_records(&tenant, &99, &10).len(), 0);
    // limit acima do teto é clampado, não rejeitado
    assert_eq!(client.tenant_records(&tenant, &0, &9999).len(), 5);
    assert!(MAX_PAGE >= 5);
}

#[test]
fn unknown_tenant_reads_are_empty() {
    let (e, client, _master) = setup();

    let ghost = text(&e, "nao-existe");
    assert_eq!(client.tenant_count(&ghost), 0);
    assert_eq!(client.tenant_records(&ghost, &0, &10).len(), 0);
    assert_eq!(client.total_records(), 0);
    assert_eq!(client.tenants().len(), 0);
}

/// O ciclo que o contrato existe para fechar: o consumidor recalcula o sha256
/// do JSON que guardou e confere contra o que foi ancorado.
#[test]
fn verify_matches_only_the_anchored_hash() {
    let (e, client, master) = setup();

    let seq = client.register(
        &master,
        &text(&e, "tenant-v"),
        &Symbol::new(&e, "refund"),
        &text(&e, "case-1"),
        &hash(&e, 7),
        &990i128,
    );

    assert!(client.verify(&seq, &hash(&e, 7)));
    // payload editado depois → hash diferente → não bate
    assert!(!client.verify(&seq, &hash(&e, 8)));
    // seq inexistente é `false`, não panic: verificar é leitura de terceiro
    assert!(!client.verify(&404, &hash(&e, 7)));
}

/// Mesma `reference` duas vezes é permitido de propósito — dois `credit_lock`
/// da mesma transação são dois eventos, e o contrato não tem contexto para
/// dizer qual repetição é erro.
#[test]
fn repeated_reference_is_allowed() {
    let (e, client, master) = setup();
    let tenant = text(&e, "tenant-dup");
    let kind = Symbol::new(&e, "credit_lock");

    client.register(&master, &tenant, &kind, &text(&e, "tx-9"), &hash(&e, 1), &1);
    client.register(&master, &tenant, &kind, &text(&e, "tx-9"), &hash(&e, 2), &1);

    assert_eq!(client.tenant_count(&tenant), 2);
}

#[test]
fn boundary_lengths_are_accepted() {
    let (e, client, master) = setup();

    client.register(
        &master,
        &long(&e, MAX_TENANT_LEN as usize),
        &Symbol::new(&e, "admin_grant"),
        &long(&e, 128),
        &hash(&e, 1),
        &1,
    );

    assert_eq!(client.total_records(), 1);
}

#[test]
#[should_panic]
fn register_requires_caller_auth() {
    // sem mock_all_auths: o require_auth do caller precisa falhar
    let e = Env::default();
    let id = e.register(AnchorLedger, ());
    let client = AnchorLedgerClient::new(&e, &id);

    client.register(
        &Address::generate(&e),
        &text(&e, "tenant-a"),
        &Symbol::new(&e, "credit_purchase"),
        &text(&e, "tx-1"),
        &hash(&e, 1),
        &1,
    );
}

#[test]
#[should_panic]
fn empty_tenant_is_rejected() {
    let (e, client, master) = setup();
    client.register(
        &master,
        &text(&e, ""),
        &Symbol::new(&e, "refund"),
        &text(&e, "r-1"),
        &hash(&e, 1),
        &1,
    );
}

#[test]
#[should_panic]
fn oversized_tenant_is_rejected() {
    let (e, client, master) = setup();
    client.register(
        &master,
        &long(&e, MAX_TENANT_LEN as usize + 1),
        &Symbol::new(&e, "refund"),
        &text(&e, "r-1"),
        &hash(&e, 1),
        &1,
    );
}

#[test]
#[should_panic]
fn oversized_reference_is_rejected() {
    let (e, client, master) = setup();
    client.register(
        &master,
        &text(&e, "tenant-a"),
        &Symbol::new(&e, "refund"),
        &long(&e, 129),
        &hash(&e, 1),
        &1,
    );
}

#[test]
#[should_panic]
fn get_record_missing_panics() {
    let (_e, client, _master) = setup();
    client.get_record(&42);
}

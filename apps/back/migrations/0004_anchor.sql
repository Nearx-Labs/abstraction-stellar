-- 0004_anchor — segundo grant por app, para o contrato de âncora.
--
-- Até aqui um app tinha UM grant: `CallContract(demo-ledger)`, com a
-- mint-quota-policy medindo itens do inventário. O anchor-ledger é um segundo
-- alvo — eventos contábeis, não itens — e precisa do seu próprio grant.
--
-- Por que não pendurar a âncora no grant que já existe: a mint-quota-policy
-- cobra 1 unidade de QUALQUER função que não seja `mint_batch`
-- (contracts/mint-quota-policy/src/contract.rs, units_of). Sob o mesmo grant,
-- cada evento ancorado comeria uma chave da cota que o tenant autorizou para o
-- inventário — e o tenant não tem como raciocinar sobre um teto que duas
-- coisas diferentes consomem.
--
-- Um grant ativo por (app, contrato-alvo). Dois grants ativos no MESMO alvo
-- continuam proibidos, pelo motivo original: o teto do tenant viraria a soma
-- dos dois e ninguém consegue raciocinar sobre isso.

DROP INDEX master_grants_active_uq;

CREATE UNIQUE INDEX master_grants_active_uq
  ON master_grants (app_id, target_contract)
  WHERE state IN ('pending', 'active');

-- ═══ Âncora no fake ledger ══════════════════════════════════════════════════
--
-- As entradas de âncora reusam `ledger_entries` com kind = 'record'. O índice
-- único de mint é parcial (WHERE kind = 'mint'), então não há colisão: um
-- evento contábil pode repetir a mesma referência de negócio, e deve — dois
-- `credit_lock` da mesma transação são dois eventos.
--
-- `uuid` é NOT NULL e para âncora carrega a REFERÊNCIA de negócio
-- (transactionId / orderId / listingId), que é o que se procura do outro lado.
-- Não é um item do inventário; nada em `records_of`/`owner_of` olha para ele.
CREATE INDEX ledger_entries_record_idx
  ON ledger_entries (app_id, created_at DESC)
  WHERE kind = 'record';

-- `payload_hash` de mint/transfer guarda 32 chars (128 bits, suficiente
-- off-chain). O de âncora guarda os 64 do sha256 COMPLETO, porque é ele que vai
-- para o `BytesN<32>` do contrato — um digest truncado é rejeitado on-chain.
COMMENT ON COLUMN ledger_entries.payload_hash IS
  'sha256 do payload. 32 chars em mint/transfer; 64 (digest completo) em record, '
  'porque o anchor-ledger recebe BytesN<32>.';

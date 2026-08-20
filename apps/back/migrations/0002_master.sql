-- 0002_master — conta mestre por tenant e o grant que o serviço consome.
--
-- Modelo: cada tenant tem UMA smart account mestre. O controle humano dela fica
-- na regra Default (passkey). Para o serviço mintar sozinho, o tenant concede
-- uma segunda regra — `CallContract(demo-ledger)` com um signer Ed25519 que a
-- API detém e a mint-quota-policy instalada.
--
-- O que essa separação compra: a chave do serviço não administra a conta (não
-- adiciona signer, não mexe em regra, não move fundo) e não minta além do teto.
-- Nada disso depende do serviço se comportar — quem recusa é o contrato.
--
-- A chave privada do serviço NÃO está aqui: é derivada de MASTER_SIGNER_SEED +
-- app_id. A coluna guarda só a pública, para conferir que o grant on-chain
-- aponta para a chave que este processo realmente tem.

ALTER TABLE apps ADD COLUMN master_account text;

ALTER TABLE apps ADD CONSTRAINT apps_master_account_chk
  CHECK (master_account IS NULL OR master_account ~ '^C[A-Z2-7]{55}$');

CREATE TYPE master_grant_state AS ENUM ('pending', 'active', 'revoked');

CREATE TABLE master_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  master_account     text NOT NULL,
  /** Regra que a API assina. NULL enquanto o grant não confirmou on-chain. */
  context_rule_id    int,
  /** Pública do signer derivado; a privada nunca é gravada. */
  ed25519_public_key bytea NOT NULL,
  target_contract    text NOT NULL,
  policy_address     text NOT NULL,
  /** Teto de ITENS na janela — é o número que o tenant autoriza. */
  max_items          int NOT NULL,
  period_ledgers     int NOT NULL,
  state              master_grant_state NOT NULL DEFAULT 'pending',
  grant_tx_hash      text,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_synced_at     timestamptz
);

-- Um grant ativo por app: se houvesse dois, o teto do tenant seria a soma, e
-- ninguém consegue raciocinar sobre isso.
CREATE UNIQUE INDEX master_grants_active_uq ON master_grants (app_id)
  WHERE state IN ('pending', 'active');
CREATE INDEX master_grants_account_idx ON master_grants (master_account);

-- ═══ Fake ledger: o registro completo fica aqui ═════════════════════════════
--
-- Espelha o modelo que o sistema consumidor já usa: on-chain vai o
-- indispensável (uuid, dono, campos), e o payload completo do evento de negócio
-- fica no banco com um hash que o commita. Assim a transação continua barata e
-- o histórico continua consultável.

CREATE TYPE ledger_entry_state AS ENUM ('pending', 'confirmed', 'failed');

CREATE TABLE ledger_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  /** UUID do item: a chave que o sistema consumidor guarda do lado dele. */
  uuid          text NOT NULL,
  /** mint | transfer — o tipo do evento de negócio. */
  kind          text NOT NULL,
  owner         text,
  /** JSON canônico do evento; é o que o hash commita. */
  payload       jsonb NOT NULL,
  payload_hash  text  NOT NULL,
  state         ledger_entry_state NOT NULL DEFAULT 'pending',
  tx_hash       text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz
);

CREATE UNIQUE INDEX ledger_entries_uuid_mint_uq ON ledger_entries (app_id, uuid)
  WHERE kind = 'mint';
CREATE INDEX ledger_entries_uuid_idx ON ledger_entries (uuid, created_at DESC);
CREATE INDEX ledger_entries_app_idx  ON ledger_entries (app_id, created_at DESC);

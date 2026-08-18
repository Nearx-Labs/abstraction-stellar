-- 0001_init — schema completo do Abstraction back.
--
-- Substitui todo o estado que hoje vive em `Map` na memória do processo:
--   services/relayer-proxy/src/policy.ts:38   (quota diária)
--   services/auth-issuer/src/index.ts:40-41   (OTPs e sessões de email)
--
-- Regra geral: nenhum segredo é gravado aqui. Chaves privadas vêm de env /
-- secret manager e são casadas por chave pública (ver fee_payer_channels).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ═══ Tenancy ════════════════════════════════════════════════════════════════

CREATE TABLE apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  network     text NOT NULL DEFAULT 'testnet',
  treasury_id text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TYPE api_key_kind AS ENUM ('publishable', 'secret');

-- A publishable key viaja no path do relayerUrl (o RelayerClient do
-- smart-account-kit não manda header nenhum além de Content-Type e
-- X-Client-*), então ela é pública por construção. Mesmo assim guardamos só o
-- hash: o lookup é por sha256 da chave que chegou.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind         api_key_kind NOT NULL,
  key_prefix   text NOT NULL,
  key_hash     bytea NOT NULL,
  label        text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_hash_uq   ON api_keys (key_hash);
CREATE INDEX        api_keys_lookup_idx ON api_keys (app_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE app_origins (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  origin text NOT NULL,
  PRIMARY KEY (app_id, origin)
);

-- Substitui loadPolicy() (services/relayer-proxy/src/policy.ts:17).
-- allowlist vazia deixa de ser "patrocina qualquer coisa": o relay recusa.
CREATE TABLE sponsorship_policies (
  app_id              uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  max_fee_per_tx      bigint NOT NULL,
  max_fee_per_day     bigint NOT NULL,
  max_fee_per_day_app bigint,
  target_allowlist    text[] NOT NULL DEFAULT '{}',
  allow_deploy        boolean NOT NULL DEFAULT true,
  deploy_fee_cap      bigint NOT NULL DEFAULT 50000000,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ═══ Contas ═════════════════════════════════════════════════════════════════

CREATE TYPE account_status AS ENUM ('pending', 'deployed', 'failed');

CREATE TABLE smart_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  contract_id           text NOT NULL,
  -- id do usuário no sistema consumidor (MintVRS); é o que amarra
  -- "usuário do produto" <-> "smart account" no acesso server-to-server.
  external_id           text,
  label                 text,
  status                account_status NOT NULL DEFAULT 'pending',
  deploy_tx_hash        text,
  deployed_ledger       bigint,
  allowance_set_at      timestamptz,
  allowance_max_per_tx  bigint,
  allowance_max_per_day bigint,
  allowance_expires_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smart_accounts_cid_chk CHECK (contract_id ~ '^C[A-Z2-7]{55}$')
);
CREATE UNIQUE INDEX smart_accounts_uq       ON smart_accounts (app_id, contract_id);
CREATE UNIQUE INDEX smart_accounts_ext_uq   ON smart_accounts (app_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX        smart_accounts_cid_idx  ON smart_accounts (contract_id);

CREATE TABLE account_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  credential_id  text  NOT NULL,
  public_key_raw bytea NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX account_credentials_uq ON account_credentials (credential_id);

CREATE TABLE webauthn_challenges (
  nonce       bytea PRIMARY KEY,
  contract_id text NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX webauthn_challenges_gc ON webauthn_challenges (expires_at);

CREATE TABLE account_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid  NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  ip         inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX account_sessions_gc ON account_sessions (expires_at) WHERE revoked_at IS NULL;

-- ═══ Fee payers ═════════════════════════════════════════════════════════════
--
-- Um pool de channel accounts com lease resolve a corrida de sequence number:
-- só o caminho {func,auth} e o outbox consomem sequence do payer (fee-bump
-- não consome o do feeSource). Os SEGREDOS não moram aqui — vêm de
-- CHANNEL_SECRETS / *_SECRET no env e são casados por public_key.

CREATE TYPE channel_state AS ENUM ('active', 'draining', 'disabled');

CREATE TABLE fee_payer_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key      text NOT NULL UNIQUE,
  -- channel  = paga as transações dos usuários
  -- operator = assina Treasury.consume
  -- owner    = assina set_allowance / allow_target (only_owner)
  -- faucet   = envia XLM de testnet para as smart accounts
  role            text NOT NULL,
  balance_stroops bigint,
  state           channel_state NOT NULL DEFAULT 'active',
  leased_until    timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_payer_channels_role_chk
    CHECK (role IN ('channel', 'operator', 'owner', 'faucet'))
);
CREATE INDEX fee_payer_channels_lease_idx ON fee_payer_channels (role, state, leased_until);

-- ═══ Ledger de patrocínio + quota atômica ═══════════════════════════════════

CREATE TYPE sponsorship_state AS ENUM
  ('reserved', 'submitted', 'succeeded', 'failed', 'released');
CREATE TYPE relay_mode AS ENUM ('invoke', 'feebump');

CREATE TABLE sponsorships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL REFERENCES apps(id),
  account_id       uuid REFERENCES smart_accounts(id),
  smart_account    text,
  mode             relay_mode NOT NULL,
  is_deploy        boolean NOT NULL DEFAULT false,
  targets          text[] NOT NULL DEFAULT '{}',
  day_utc          date   NOT NULL,
  -- reserved = o teto que a transação PODE custar (fee da tx montada);
  -- charged  = o feeCharged real lido do resultado. Cobrar o teto era o bug B2.
  reserved_stroops bigint NOT NULL,
  charged_stroops  bigint,
  state            sponsorship_state NOT NULL DEFAULT 'reserved',
  tx_hash          text,
  tx_status        text,
  error_code       text,
  channel_id       uuid REFERENCES fee_payer_channels(id),
  idempotency_key  text,
  reserved_until   timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz
);
CREATE INDEX sponsorships_acct_day_idx ON sponsorships (smart_account, day_utc);
CREATE INDEX sponsorships_stale_idx    ON sponsorships (reserved_until) WHERE state = 'reserved';
CREATE UNIQUE INDEX sponsorships_hash_uq ON sponsorships (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX sponsorships_idem_uq ON sponsorships (app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE fee_quota_daily (
  app_id           uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  smart_account    text NOT NULL,
  day_utc          date NOT NULL,
  reserved_stroops bigint NOT NULL DEFAULT 0,
  settled_stroops  bigint NOT NULL DEFAULT 0,
  tx_count         int    NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, smart_account, day_utc),
  CONSTRAINT fee_quota_nonneg CHECK (reserved_stroops >= 0 AND settled_stroops >= 0)
);

-- ═══ Outbox do Treasury ═════════════════════════════════════════════════════
--
-- debitTreasury era `void debitTreasury(...)` — fire-and-forget, sem poll, com
-- o erro engolido no catch. Um débito perdido era invisível. Agora tudo que
-- toca o Treasury passa por aqui e é retentado.

CREATE TYPE outbox_kind  AS ENUM ('consume', 'set_allowance', 'allow_target', 'withdraw');
CREATE TYPE outbox_state AS ENUM ('pending', 'in_flight', 'done', 'failed', 'dead');

CREATE TABLE treasury_outbox (
  id              bigserial PRIMARY KEY,
  app_id          uuid NOT NULL REFERENCES apps(id),
  kind            outbox_kind NOT NULL,
  sponsorship_id  uuid REFERENCES sponsorships(id),
  payload         jsonb NOT NULL,
  dedupe_key      text  NOT NULL,
  state           outbox_state NOT NULL DEFAULT 'pending',
  attempts        int   NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  tx_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE UNIQUE INDEX treasury_outbox_dedupe_uq ON treasury_outbox (dedupe_key);
CREATE INDEX treasury_outbox_ready_idx ON treasury_outbox (next_attempt_at)
  WHERE state IN ('pending', 'failed');

-- ═══ Faucet ═════════════════════════════════════════════════════════════════

CREATE TYPE faucet_state AS ENUM
  ('pending', 'xlm_sent', 'allowance_set', 'done', 'failed');

CREATE TABLE faucet_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              uuid NOT NULL REFERENCES apps(id),
  account_id          uuid NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  smart_account       text NOT NULL,
  amount_stroops      bigint NOT NULL,
  state               faucet_state NOT NULL DEFAULT 'pending',
  xlm_tx_hash         text,
  allowance_outbox_id bigint REFERENCES treasury_outbox(id),
  requester_ip        inet,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX faucet_claims_acct_idx ON faucet_claims (account_id, created_at DESC);
CREATE INDEX faucet_claims_ip_idx   ON faucet_claims (requester_ip, created_at DESC);
-- Um claim em voo por conta: mata o duplo clique e o duplo pod de uma vez.
CREATE UNIQUE INDEX faucet_claims_inflight_uq ON faucet_claims (account_id)
  WHERE state IN ('pending', 'xlm_sent', 'allowance_set');

-- ═══ Session keys ═══════════════════════════════════════════════════════════
--
-- O on-chain não sabe *o que* uma context rule é (session key? email signer?),
-- o probe do kit para no rule id 8, e o histórico de revogadas some. O DB
-- guarda o metadado — mas não é fonte de verdade: sessionSync reconcilia
-- contra get_context_rule.

CREATE TYPE session_key_state AS ENUM
  ('pending', 'active', 'expired', 'revoked', 'failed');

CREATE TABLE session_grants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                 uuid NOT NULL REFERENCES apps(id),
  account_id             uuid NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  smart_account          text NOT NULL,
  context_rule_id        int,
  name                   text NOT NULL,
  target_contract        text NOT NULL,
  ed25519_public_key     bytea NOT NULL,
  policy_address         text NOT NULL,
  spending_limit_stroops bigint NOT NULL,
  period_ledgers         int    NOT NULL,
  valid_until_ledger     bigint NOT NULL,
  valid_until_est        timestamptz,
  state                  session_key_state NOT NULL DEFAULT 'pending',
  grant_tx_hash          text,
  revoke_tx_hash         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz,
  last_synced_at         timestamptz
);
CREATE UNIQUE INDEX session_grants_rule_uq ON session_grants (smart_account, context_rule_id)
  WHERE context_rule_id IS NOT NULL;
CREATE INDEX session_grants_active_idx ON session_grants (account_id, state);

-- ═══ Email (sai dos Maps do auth-issuer) ════════════════════════════════════

CREATE TABLE email_otps (
  email_norm text PRIMARY KEY,
  code_hash  bytea NOT NULL,
  attempts   int   NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_otps_gc ON email_otps (expires_at);

CREATE TABLE email_sessions (
  token_hash   bytea PRIMARY KEY,
  email_norm   text  NOT NULL,
  subject_hash bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_sessions_gc ON email_sessions (expires_at);

CREATE TABLE attestations_issued (
  id           bigserial PRIMARY KEY,
  subject_hash bytea NOT NULL,
  challenge    bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now()
);
-- Endurecimento novo: o mesmo (subject, challenge) só é assinado uma vez.
CREATE UNIQUE INDEX attestations_replay_uq ON attestations_issued (subject_hash, challenge);

-- ═══ Idempotência + rate limit ══════════════════════════════════════════════

CREATE TABLE idempotency_keys (
  app_id          uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key             text NOT NULL,
  request_hash    bytea NOT NULL,
  state           text NOT NULL DEFAULT 'in_flight',
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (app_id, key)
);
CREATE INDEX idempotency_gc ON idempotency_keys (expires_at);

CREATE TABLE rate_limit_buckets (
  bucket_key   text PRIMARY KEY,
  count        int  NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL
);
CREATE INDEX rate_limit_gc ON rate_limit_buckets (expires_at);

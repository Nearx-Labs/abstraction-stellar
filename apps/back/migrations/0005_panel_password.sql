-- 0005_panel_password — login do painel por e-mail e senha.
--
-- A sessão do painel nasceu amarrada a WebAuthn: `/authn/challenge` +
-- `/authn/verify` provam posse da passkey e devolvem o cookie. Isso pressupõe
-- que a conta TEM uma passkey registrada.
--
-- A conta mestre provisionada pelo serviço não tem: ela é custodial, com
-- signer Ed25519 derivado, e o tenant nunca registrou digital nenhuma. Sem
-- outro caminho de login, o dono da conta não consegue nem OLHAR o próprio
-- painel.
--
-- Daí este login. Ele prova "quem é o humano", não "quem controla a chave" —
-- são coisas diferentes, e no modelo custodial só a primeira cabe ao usuário.
-- A passkey continua existindo para quem quer auto-custódia; os dois caminhos
-- emitem a mesma sessão.

CREATE TABLE panel_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
  email         text NOT NULL,
  /** scrypt, no formato `salt:hash` em hex. Sem dependência nova: é do Node. */
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- E-mail é identificador de login: único no serviço inteiro, e case-insensitive
-- porque ninguém lembra se cadastrou com maiúscula.
CREATE UNIQUE INDEX panel_credentials_email_uq ON panel_credentials (lower(email));
CREATE INDEX panel_credentials_account_idx ON panel_credentials (account_id);

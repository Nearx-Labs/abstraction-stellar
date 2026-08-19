-- 0003 — grant sem prazo.
--
-- O modelo de permissão passou a ser o de um grant de dApp: escopo (um
-- contrato) + limite (teto de gasto numa janela deslizante) + revogação. O
-- prazo virou opcional, então `valid_until_ledger` pode ser nulo.
--
-- Antes o prazo era obrigatório por uma limitação de implementação, não por
-- desenho: a chave da sessão vivia só na memória da aba, então uma permissão
-- longa deixaria regras órfãs on-chain. Com a chave persistida no cliente, o
-- prazo deixa de ser necessário.

ALTER TABLE session_grants ALTER COLUMN valid_until_ledger DROP NOT NULL;
ALTER TABLE session_grants ALTER COLUMN period_ledgers SET DEFAULT 17280;

-- 0002_media — arquivos de mídia dos itens.
--
-- O contrato guarda só a URI: um Soroban cobra por byte armazenado, então
-- imagem on-chain é inviável (e o campo é limitado a 512 caracteres de
-- propósito, porque quem paga a fee é o sponsor). O arquivo fica aqui e o
-- contrato aponta para ele.
--
-- Bytes em Postgres, e não em disco, porque assim o serviço continua sem
-- estado: sobe em qualquer réplica, sem volume, e o arquivo sobrevive ao
-- restart do container. Para volume de produção o caminho é S3 — a coluna
-- `external_url` já existe para quando a migração acontecer, e aí `data` fica
-- nulo.

CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid REFERENCES apps(id) ON DELETE CASCADE,
  /** sha256 do conteúdo: mesmo arquivo enviado duas vezes reaproveita a linha. */
  content_hash bytea NOT NULL,
  mime_type    text  NOT NULL,
  byte_size    int   NOT NULL,
  filename     text,
  data         bytea,
  external_url text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_has_content CHECK (data IS NOT NULL OR external_url IS NOT NULL)
);

CREATE UNIQUE INDEX media_hash_uq ON media (app_id, content_hash);

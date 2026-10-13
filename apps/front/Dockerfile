# O front é bundle estático — nada de runtime Node em produção. As VITE_* são
# variáveis de BUILD: entram no bundle, então cada ambiente gera sua imagem.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk upgrade --no-cache

COPY package.json package-lock.json* ./
RUN npm ci

# Sem default nenhum, de propósito. Os defaults antigos eram os do ambiente
# publicado, e o CI construía UMA imagem sem build-arg: o painel de homologação
# e o de produção saíam idênticos, os dois falando com a API de produção com a
# publishable key do homolog. Agora o CI constrói uma imagem por ambiente
# (front-hml, front-prod) a partir das variáveis do GitHub Environment, e o
# build falha se faltar o essencial.
#
# Rodando local, `npm run dev` lê os VITE_* do .env e não passa por aqui.
ARG VITE_API_URL
# Pública por construção: viaja no path do relayerUrl, porque o RelayerClient do
# kit não manda header além de Content-Type e X-Client-*.
ARG VITE_PUBLISHABLE_KEY
ARG VITE_RPC_URL
ARG VITE_NETWORK_PASSPHRASE
ARG VITE_EXPLORER
ARG VITE_TREASURY
ARG VITE_XLM_SAC
ARG VITE_DEMO_LEDGER
ARG VITE_MINT_QUOTA_POLICY
ARG VITE_ACCOUNT_WASM_HASH
ARG VITE_ED25519_VERIFIER
ARG VITE_WEBAUTHN_VERIFIER
ARG VITE_EMAIL_VERIFIER
ARG VITE_SPENDING_LIMIT_POLICY
ENV VITE_API_URL=$VITE_API_URL \
    VITE_PUBLISHABLE_KEY=$VITE_PUBLISHABLE_KEY \
    VITE_RPC_URL=$VITE_RPC_URL \
    VITE_NETWORK_PASSPHRASE=$VITE_NETWORK_PASSPHRASE \
    VITE_EXPLORER=$VITE_EXPLORER \
    VITE_TREASURY=$VITE_TREASURY \
    VITE_XLM_SAC=$VITE_XLM_SAC \
    VITE_DEMO_LEDGER=$VITE_DEMO_LEDGER \
    VITE_MINT_QUOTA_POLICY=$VITE_MINT_QUOTA_POLICY \
    VITE_ACCOUNT_WASM_HASH=$VITE_ACCOUNT_WASM_HASH \
    VITE_ED25519_VERIFIER=$VITE_ED25519_VERIFIER \
    VITE_WEBAUTHN_VERIFIER=$VITE_WEBAUTHN_VERIFIER \
    VITE_EMAIL_VERIFIER=$VITE_EMAIL_VERIFIER \
    VITE_SPENDING_LIMIT_POLICY=$VITE_SPENDING_LIMIT_POLICY

# A rede, a API e os contratos que o produto usa decidem para onde o painel
# aponta: sem eles o bundle cairia nos fallbacks de testnet de
# src/lib/config.ts sem ninguém perceber. Verifiers de passkey/email e a
# spending-limit são do fluxo de auto-custódia e podem ficar de fora.
RUN for v in VITE_API_URL VITE_PUBLISHABLE_KEY VITE_RPC_URL VITE_NETWORK_PASSPHRASE VITE_EXPLORER \
             VITE_TREASURY VITE_XLM_SAC VITE_DEMO_LEDGER VITE_MINT_QUOTA_POLICY \
             VITE_ACCOUNT_WASM_HASH VITE_ED25519_VERIFIER; do \
      eval "val=\${$v}"; \
      if [ -z "$val" ]; then echo "build-arg $v é obrigatório" >&2; exit 1; fi; \
    done

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ── Stage 2: nginx ───────────────────────────────────────────────────────────
# A imagem unprivileged já vem com os diretórios temporários graváveis pelo uid
# 101 e escutando em 8080. A nginx:alpine comum roda como root e, ao trocar o
# USER, quebra em mkdir() /var/cache/nginx.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner

USER root
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1

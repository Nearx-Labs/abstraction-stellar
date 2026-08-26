# O front é bundle estático — nada de runtime Node em produção. As VITE_* são
# variáveis de BUILD: entram no bundle, então cada ambiente gera sua imagem.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk upgrade --no-cache

COPY package.json package-lock.json* ./
RUN npm ci

# Os defaults são os do ambiente publicado, e não os de desenvolvimento, porque
# o CI constrói a imagem SEM passar build-arg: o que estiver aqui é o que vai
# para o bundle. Com `localhost:8080` e `pk_test_dev` o front publicado subia,
# respondia 200 e não conseguia falar com API nenhuma.
#
# Rodando local, `npm run dev` lê os VITE_* do .env e não passa por aqui.
ARG VITE_API_URL=https://api.abstraction.nearx.com.br
# Pública por construção: viaja no path do relayerUrl, porque o RelayerClient do
# kit não manda header além de Content-Type e X-Client-*.
ARG VITE_PUBLISHABLE_KEY=pk_homolog_eddae804d009246c7c296a2cadfa4deb
ARG VITE_RPC_URL
ARG VITE_NETWORK_PASSPHRASE
ARG VITE_TREASURY
ARG VITE_XLM_SAC
ENV VITE_API_URL=$VITE_API_URL \
    VITE_PUBLISHABLE_KEY=$VITE_PUBLISHABLE_KEY \
    VITE_RPC_URL=$VITE_RPC_URL \
    VITE_NETWORK_PASSPHRASE=$VITE_NETWORK_PASSPHRASE \
    VITE_TREASURY=$VITE_TREASURY \
    VITE_XLM_SAC=$VITE_XLM_SAC

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

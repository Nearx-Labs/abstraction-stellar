# O front é bundle estático — nada de runtime Node em produção. As VITE_* são
# variáveis de BUILD: entram no bundle, então cada ambiente gera sua imagem.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk upgrade --no-cache

COPY package.json package-lock.json* ./
RUN npm ci

ARG VITE_API_URL=http://localhost:8080
ARG VITE_PUBLISHABLE_KEY=pk_test_dev
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

# Mesmo padrão do resto da casa: multi-stage, alpine atualizado, usuário
# numérico (com runAsNonRoot o kubelet recusa USER textual) e healthcheck que
# usa o próprio node, sem depender de curl/wget na imagem.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk upgrade --no-cache

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Stage 2: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
RUN apk upgrade --no-cache

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 back -G nodejs

# Em runtime o processo é `node dist/index.js` e nada invoca npm/npx; tirá-los
# elimina a maior parte dos achados de scan de container.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm

COPY --from=builder --chown=back:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=back:nodejs /app/dist ./dist
COPY --chown=back:nodejs package.json ./
# As migrações rodam no boot, antes do listen — precisam estar na imagem.
COPY --chown=back:nodejs migrations ./migrations

USER 1001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" || exit 1

CMD ["node", "dist/index.js"]

#!/usr/bin/env bash
# Stack de desenvolvimento: Postgres no docker, back e front com hot reload.
#
#   ./dev.sh
#
# Substitui o start-demo.sh. A diferença que importa: as chaves de serviço não
# são mais improvisadas a cada boot. Em desenvolvimento, channel/faucet são
# derivadas de forma determinística e financiadas no friendbot; owner e
# operator vêm das identidades do stellar CLI que realmente controlam o
# Treasury implantado no testnet — sem elas o faucet envia XLM mas não ativa a
# cota, porque set_allowance é #[only_owner].
set -euo pipefail
cd "$(dirname "$0")"

export NODE_ENV=development
export DATABASE_URL=${DATABASE_URL:-postgres://abstraction:abstraction@localhost:5434/abstraction}
export TREASURY_CONTRACT_ID=${TREASURY_CONTRACT_ID:-CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV}
export XLM_SAC_ADDRESS=${XLM_SAC_ADDRESS:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}

if command -v stellar >/dev/null 2>&1; then
  export TREASURY_OWNER_SECRET=${TREASURY_OWNER_SECRET:-$(stellar keys show demo 2>/dev/null || true)}
  export TREASURY_OPERATOR_SECRET=${TREASURY_OPERATOR_SECRET:-$(stellar keys show relayer 2>/dev/null || true)}
fi

if [ -z "${TREASURY_OWNER_SECRET:-}" ]; then
  echo "aviso: sem a chave do owner do Treasury, o faucet não vai ativar a cota."
  echo "       rode 'npm run bootstrap' em apps/back para ver o diagnóstico."
fi

echo "▸ subindo o Postgres"
docker compose up -d db
until docker compose exec -T db pg_isready -U abstraction -d abstraction >/dev/null 2>&1; do
  sleep 1
done

trap 'kill 0' EXIT

echo "▸ back  http://localhost:8080"
(cd apps/back && npm run dev) &

echo "▸ front http://localhost:5173"
(cd apps/front && npm run dev) &

wait

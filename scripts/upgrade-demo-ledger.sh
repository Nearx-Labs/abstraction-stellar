#!/usr/bin/env bash
# Upgrade do código de um demo-ledger já deployado, sem trocar o endereço.
#
#   scripts/upgrade-demo-ledger.sh --network testnet|mainnet --ledger <C…> \
#     --admin <identidade> --wasm <demo_ledger.wasm> [--source <identidade>] \
#     [--extend-ledgers N] [--send]
#
#   --ledger    endereço do demo-ledger (DEMO_LEDGER_CONTRACT_ID da instância)
#   --admin     identidade do stellar CLI que é o `admin()` do ledger (chave fria)
#   --wasm      wasm congelado; o sha256 tem que bater com contracts/RELEASE.sha256
#   --source    quem paga upload e extensão (padrão: o próprio admin)
#   --extend-ledgers N
#               estende o TTL do código novo em N ledgers. Padrão: 2073600
#               (120 dias) na testnet, 0 na mainnet
#   --send      faz o upgrade de verdade. Sem ele, o script sobe o wasm (upload
#               e restore são idempotentes e não mexem em contrato nenhum),
#               confere tudo e só SIMULA o upgrade
#
# O storage continua: o upgrade troca só o código da instância. Antes e depois o
# script compara `total_supply` e lê o primeiro registro; depois exige
# `version() == 3`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="" LEDGER="" ADMIN="" SOURCE="" WASM="" EXTEND="" SEND=0

while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --ledger) LEDGER="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --wasm) WASM="$2"; shift 2 ;;
    --extend-ledgers) EXTEND="$2"; shift 2 ;;
    --send) SEND=1; shift ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

for v in NETWORK LEDGER ADMIN WASM; do
  if [ -z "${!v}" ]; then echo "--$(echo "$v" | tr '[:upper:]' '[:lower:]') é obrigatório" >&2; exit 2; fi
done
case "$NETWORK" in testnet|mainnet) ;; *) echo "--network: testnet ou mainnet" >&2; exit 2 ;; esac
[[ "$LEDGER" =~ ^C[A-Z2-7]{55}$ ]] || { echo "--ledger inválido: $LEDGER" >&2; exit 2; }
[ -f "$WASM" ] || { echo "wasm não encontrado: $WASM" >&2; exit 2; }
SOURCE="${SOURCE:-$ADMIN}"
if [ -z "$EXTEND" ]; then
  if [ "$NETWORK" = "mainnet" ]; then EXTEND=0; else EXTEND=2073600; fi
fi
[[ "$EXTEND" =~ ^[0-9]+$ ]] || { echo "--extend-ledgers: número de ledgers" >&2; exit 2; }

log() { echo "[upgrade:$NETWORK] $*" >&2; }
read_only() {
  stellar contract invoke --id "$LEDGER" --source-account "$ADMIN" --network "$NETWORK" \
    --send=no -- "$@" 2>/dev/null
}

# 1. O wasm é o congelado.
WANT="$(awk '$2 == "demo_ledger.wasm" {print $1}' "$ROOT/contracts/RELEASE.sha256")"
GOT="$(shasum -a 256 "$WASM" | awk '{print $1}')"
[ -n "$WANT" ] || { echo "contracts/RELEASE.sha256 não tem demo_ledger.wasm" >&2; exit 1; }
[ "$GOT" = "$WANT" ] || {
  echo "sha256 do wasm ($GOT) não bate com contracts/RELEASE.sha256 ($WANT)" >&2
  exit 1
}
log "wasm confere com RELEASE.sha256: $GOT"

# 2. A identidade é mesmo o admin do ledger (senão o upgrade falha na auth).
ADMIN_ADDR="$(stellar keys address "$ADMIN")"
ONCHAIN_ADMIN="$(read_only admin | tr -d '"')"
[ "$ADMIN_ADDR" = "$ONCHAIN_ADMIN" ] || {
  echo "admin do ledger é $ONCHAIN_ADMIN, não $ADMIN ($ADMIN_ADDR)" >&2
  exit 1
}
log "admin confere: $ADMIN_ADDR"

BEFORE_VERSION="$(read_only version || echo "sem version() (v2)")"
BEFORE_SUPPLY="$(read_only total_supply)"
BEFORE_FIRST="$(read_only page --offset 0 --limit 1)"
log "antes: version=$BEFORE_VERSION total_supply=$BEFORE_SUPPLY"
if [ "$BEFORE_VERSION" = "3" ]; then
  log "o ledger já está na v3; nada a fazer"
  exit 0
fi

if [ "$NETWORK" = "mainnet" ] && [ "$SEND" = 1 ]; then
  echo "Mainnet: o upgrade troca o código do ledger em produção." >&2
  read -r -p "Digite 'mainnet' para continuar: " answer
  [ "$answer" = "mainnet" ] || { echo "cancelado" >&2; exit 1; }
fi

# 3. Código na rede. Upload de wasm que já existe devolve o mesmo hash; restore
# traz de volta se tiver arquivado (o upgrade de um código arquivado falharia).
NET=(--source-account "$SOURCE" --network "$NETWORK")
log "upload do wasm"
HASH="$(stellar contract upload --wasm "$WASM" "${NET[@]}")"
[ "$HASH" = "$GOT" ] || { echo "upload devolveu $HASH, esperado $GOT" >&2; exit 1; }
stellar contract restore --wasm-hash "$HASH" "${NET[@]}" >/dev/null

# 4. Simulação: auth do admin, recursos e fee, sem enviar.
log "simulando upgrade"
stellar contract invoke --id "$LEDGER" --source-account "$ADMIN" --network "$NETWORK" \
  --send=no -- upgrade --new_wasm_hash "$HASH" >/dev/null
log "simulação ok"

if [ "$SEND" != 1 ]; then
  log "parado antes do upgrade (rode de novo com --send para aplicar)"
  exit 0
fi

# 5. Upgrade e conferência.
log "upgrade para $HASH"
stellar contract invoke --id "$LEDGER" --source-account "$ADMIN" --network "$NETWORK" \
  -- upgrade --new_wasm_hash "$HASH" >/dev/null
if [ "$EXTEND" -gt 0 ]; then
  log "estendendo o TTL do código em $EXTEND ledgers"
  stellar contract extend --wasm-hash "$HASH" --ledgers-to-extend "$EXTEND" \
    --ttl-ledger-only "${NET[@]}" >/dev/null
fi

AFTER_VERSION="$(read_only version)"
AFTER_SUPPLY="$(read_only total_supply)"
AFTER_FIRST="$(read_only page --offset 0 --limit 1)"
log "depois: version=$AFTER_VERSION total_supply=$AFTER_SUPPLY"
[ "$AFTER_VERSION" = "3" ] || { echo "version() deveria ser 3 e é $AFTER_VERSION" >&2; exit 1; }
[ "$AFTER_SUPPLY" = "$BEFORE_SUPPLY" ] || {
  echo "total_supply mudou: $BEFORE_SUPPLY → $AFTER_SUPPLY" >&2
  exit 1
}
[ "$AFTER_FIRST" = "$BEFORE_FIRST" ] || { echo "o primeiro registro mudou depois do upgrade" >&2; exit 1; }
log "upgrade ok: registros intactos, version() = 3"

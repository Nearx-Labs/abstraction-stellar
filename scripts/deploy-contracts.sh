#!/usr/bin/env bash
# Deploy dos contratos que uma instância do Abstraction usa, numa rede.
#
#   scripts/deploy-contracts.sh --network testnet|mainnet --source <identidade> \
#     --admin <G…> --owner <G…> --operator <G…> [--wasm-dir <pasta>]
#
#   --source    identidade do stellar CLI que paga o deploy (precisa de XLM)
#   --admin     chave FRIA: faz upgrade dos ledgers e troca o registrar
#   --owner     chave de owner do serviço (TREASURY_OWNER_SECRET). É também o
#               registrar dos ledgers: quem habilita a conta mestre no
#               provisionamento (set_minter / set_writer)
#   --operator  chave de operator do Treasury (TREASURY_OPERATOR_SECRET)
#   --wasm-dir  pasta com os .wasm congelados (contracts-v1). Sem ela, builda
#               agora; com ela, confere o sha256 contra contracts/RELEASE.sha256
#               antes de enviar qualquer coisa
#   --extend-ledgers N
#               estende o TTL de instâncias e wasm em N ledgers no fim. Padrão:
#               2073600 (120 dias) na testnet, 0 na mainnet. Na mainnet toda
#               entrada nova já nasce com 120 dias, e os ledgers e a policy
#               renovam a própria instância a cada escrita — estender no deploy
#               é pagar aluguel adiantado. Na testnet o mínimo é 7 dias: sem
#               estender para os mesmos 120 dias, o primeiro mint estenderia a
#               instância e o código de uma vez (~75 XLM, acima do teto de fee),
#               e o ensaio não refletiria a mainnet. Medido na testnet (2026-10-12): cada
#               wasm de ~13 KB estendido por ~173 dias custou ~120 XLM; na
#               mainnet, com o estado da rede abaixo do alvo, o aluguel por KB
#               é ~6,7x menor.
#
# Saída: as linhas de env da instância, prontas para colar. Nada aqui é secreto.
#
# O deploy é a parte imutável: ledgers e policy não sabem se reconfigurar
# depois. Por isso a mesma pasta de wasm vai para hml, para o ensaio de prod e
# para a mainnet — e o sha256 é conferido em vez de confiado.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="" SOURCE="" ADMIN="" OWNER="" OPERATOR="" WASM_DIR="" EXTEND=""

while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --operator) OPERATOR="$2"; shift 2 ;;
    --wasm-dir) WASM_DIR="$2"; shift 2 ;;
    --extend-ledgers) EXTEND="$2"; shift 2 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

for v in NETWORK SOURCE ADMIN OWNER OPERATOR; do
  if [ -z "${!v}" ]; then echo "--$(echo "$v" | tr 'A-Z' 'a-z') é obrigatório" >&2; exit 2; fi
done
case "$NETWORK" in testnet|mainnet) ;; *) echo "--network: testnet ou mainnet" >&2; exit 2 ;; esac
for addr in "$ADMIN" "$OWNER" "$OPERATOR"; do
  [[ "$addr" =~ ^G[A-Z2-7]{55}$ ]] || { echo "endereço inválido: $addr" >&2; exit 2; }
done

log() { echo "[deploy:$NETWORK] $*" >&2; }

if [ -z "$WASM_DIR" ]; then
  log "buildando os contratos"
  (cd "$ROOT" && stellar contract build >&2)
  WASM_DIR="$ROOT/target/wasm32v1-none/release"
else
  RELEASE="$ROOT/contracts/RELEASE.sha256"
  [ -f "$RELEASE" ] || { echo "falta $RELEASE para conferir os wasm" >&2; exit 1; }
  log "conferindo sha256 contra contracts/RELEASE.sha256"
  (cd "$WASM_DIR" && shasum -a 256 -c "$RELEASE" >&2)
fi

WASMS=(meta_account ed25519_verifier mint_quota_policy demo_ledger anchor_ledger treasury)
for w in "${WASMS[@]}"; do
  [ -f "$WASM_DIR/$w.wasm" ] || { echo "falta $WASM_DIR/$w.wasm" >&2; exit 1; }
done

if [ "$NETWORK" = "mainnet" ]; then
  echo "Mainnet: isto gasta XLM de $SOURCE e os contratos não se desfazem." >&2
  read -r -p "Digite 'mainnet' para continuar: " answer
  [ "$answer" = "mainnet" ] || { echo "cancelado" >&2; exit 1; }
fi

NET=(--source-account "$SOURCE" --network "$NETWORK")
if [ -z "$EXTEND" ]; then
  if [ "$NETWORK" = "mainnet" ]; then EXTEND=0; else EXTEND=2073600; fi
fi
[[ "$EXTEND" =~ ^[0-9]+$ ]] || { echo "--extend-ledgers: número de ledgers" >&2; exit 2; }

# Upload explícito de cada wasm e depois restore. Um wasm que JÁ existe na rede
# mas arquivou (o da smart account estava assim na testnet) volta do `upload`
# com o hash de sempre e continua arquivado — e o primeiro deploy que o usa paga
# a restauração dentro da transação (18,5 XLM no provisionamento, que o teto de
# fee recusou). `restore` em wasm vivo é no-op.
# bash 3.2 (o do macOS) não tem array associativo: um HASH_<wasm> por contrato.
hash_of() { local v="HASH_$1"; echo "${!v}"; }
for w in "${WASMS[@]}"; do
  log "upload: $w"
  printf -v "HASH_$w" '%s' "$(stellar contract upload --wasm "$WASM_DIR/$w.wasm" "${NET[@]}")"
  stellar contract restore --wasm-hash "$(hash_of "$w")" "${NET[@]}" >/dev/null
done

deploy() {
  local wasm="$1"; shift
  stellar contract deploy --wasm-hash "$(hash_of "$wasm")" "${NET[@]}" "$@"
}

ACCOUNT_WASM_HASH="$(hash_of meta_account)"

log "deploy: ed25519-verifier"
ED25519="$(deploy ed25519_verifier)"
log "deploy: mint-quota-policy"
POLICY="$(deploy mint_quota_policy)"
log "deploy: demo-ledger (admin=$ADMIN, registrar=$OWNER)"
LEDGER="$(deploy demo_ledger -- --admin "$ADMIN" --registrar "$OWNER")"
log "deploy: anchor-ledger (admin=$ADMIN, registrar=$OWNER)"
ANCHOR="$(deploy anchor_ledger -- --admin "$ADMIN" --registrar "$OWNER")"

XLM_SAC="$(stellar contract id asset --asset native --network "$NETWORK")"
log "deploy: treasury (owner=$OWNER, operator=$OPERATOR, token=$XLM_SAC)"
TREASURY="$(deploy treasury -- --owner "$OWNER" --operator "$OPERATOR" --token "$XLM_SAC")"

if [ "$EXTEND" -gt 0 ]; then
  log "estendendo o TTL das instâncias e dos wasm em $EXTEND ledgers"
  for id in "$ED25519" "$POLICY" "$LEDGER" "$ANCHOR" "$TREASURY"; do
    stellar contract extend --id "$id" --ledgers-to-extend "$EXTEND" --ttl-ledger-only "${NET[@]}" >/dev/null
  done
  for w in "${WASMS[@]}"; do
    stellar contract extend --wasm-hash "$(hash_of "$w")" --ledgers-to-extend "$EXTEND" --ttl-ledger-only "${NET[@]}" >/dev/null
  done
fi

if [ "$NETWORK" = "mainnet" ]; then
  PASSPHRASE="Public Global Stellar Network ; September 2015"
else
  PASSPHRASE="Test SDF Network ; September 2015"
fi

cat <<EOF
NETWORK_PASSPHRASE=$PASSPHRASE
XLM_SAC_ADDRESS=$XLM_SAC
ACCOUNT_WASM_HASH=$ACCOUNT_WASM_HASH
ED25519_VERIFIER_ADDRESS=$ED25519
MINT_QUOTA_POLICY_ADDRESS=$POLICY
DEMO_LEDGER_CONTRACT_ID=$LEDGER
ANCHOR_CONTRACT_ID=$ANCHOR
TREASURY_CONTRACT_ID=$TREASURY
EOF

#!/usr/bin/env bash
# Sobe a stack completa do MVP no testnet:
#   auth-issuer   :8788  (login por email → attestation)
#   relayer-proxy :8787  (fees patrocinadas + policy + débito no treasury)
#   client        :5173  (web app com passkey)
#
# Pré-requisitos: identidades `demo` e `relayer` no stellar CLI (criadas e
# financiadas via friendbot), npm install feito nos três pacotes JS.
set -euo pipefail
cd "$(dirname "$0")"

XLM_SAC=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
TREASURY=CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV

# A conta do relayer paga as fees e é o operator do Treasury.
FEE_PAYER_SECRET=$(stellar keys show relayer)
export FEE_PAYER_SECRET
export TREASURY_CONTRACT_ID=$TREASURY
export TARGET_ALLOWLIST=$XLM_SAC

trap 'kill 0' EXIT

(cd services/auth-issuer && npm run dev) &
(cd services/relayer-proxy && npm run dev) &
(cd client && npm run dev) &

wait

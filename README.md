# Abstraction

Generalized abstraction na Stellar: smart accounts com login por passkey, sem
seed phrase e com taxas patrocinadas — o modelo da Xion portado para o desenho
nativo de Stellar/Soroban.

## Arquitetura

- **On-chain** — contract account (`MetaAccount`) construída sobre o framework
  de smart accounts da OpenZeppelin ([`stellar-accounts`]). A autorização é
  organizada em *context rules*: cada regra vincula signers (passkeys WebAuthn,
  Ed25519, endereços delegados) e policies (spending limit, threshold) a um
  escopo (`Default`, `CallContract`, `CreateContract`).
- **Verificadores** — contratos reutilizáveis de verificação criptográfica:
  `webauthn-verifier` (secp256r1/P-256, passkeys) e `ed25519-verifier`.
- **Cliente** — web app com [`smart-account-kit`]: cria a passkey, deriva e
  implanta a conta, assina e submete transações.
- **Fees** — patrocinadas via fee-bump por relayer (OpenZeppelin Relayer /
  Stellar Channels Service); o usuário não precisa de XLM.

Anti-replay, expiração de assinatura e binding de rede/invocação são nativos do
protocolo (nonce do `SorobanAuthorizationEntry`, consumido pelo host); o
contrato verifica provas e aplica policies. Os signers assinam
`sha256(signature_payload || context_rule_ids.to_xdr())`, o que impede ataques
de downgrade de regra.

## Estrutura

```
contracts/
  meta-account/                # a smart account (CustomAccountInterface + SmartAccount)
  webauthn-verifier/           # verificador de assertions WebAuthn (passkey)
  ed25519-verifier/            # verificador Ed25519 (fallback/admin/dev)
  email-attestation-verifier/  # verificador de attestations de email (Fase 2)
  treasury/                    # policy on-chain do paymaster (Fase 3)
  spending-limit-policy/       # teto de gasto em janela deslizante (Fase 4)
client/                        # web app (Vite + TS + smart-account-kit)
services/
  auth-issuer/                 # emissor off-chain de attestations (OTP por email)
  relayer-proxy/               # submissão patrocinada com policy (Fase 3)
```

## Fee abstraction (Fase 3)

Modelo híbrido, sponsor-pays: o usuário nunca toca em XLM.

- **On-chain ([treasury](contracts/treasury/src/contract.rs))** — a camada
  declarativa/auditável: orçamento do sponsor em token SEP-41, allowlist de
  contratos patrocináveis e allowance por usuário (`max_per_tx`,
  `max_per_day`, expiração). O relayer é o `operator` e debita cada
  patrocínio via `consume`, que emite evento — o gasto é público.
- **Off-chain ([relayer-proxy](services/relayer-proxy/src/index.ts))** — o
  enforcement operacional: simula custo, aplica allowlist + teto por tx +
  quota diária em memória, então paga a transação (monta a partir de
  `{func, auth}` ou envelopa `{xdr}` assinado em fee-bump). Compatível com o
  protocolo `relayerUrl` do smart-account-kit. Com `TREASURY_CONTRACT_ID`
  definido, debita o consumo on-chain (payer = operator); com
  `CHANNELS_URL`/`CHANNELS_API_KEY`, encaminha a submissão ao OpenZeppelin
  Relayer mantendo a policy na frente.

```bash
cd services/relayer-proxy && npm install && npm run dev   # proxy em :8787
# env: FEE_PAYER_SECRET, TARGET_ALLOWLIST, MAX_FEE_PER_TX, MAX_FEE_PER_DAY,
#      TREASURY_CONTRACT_ID, CHANNELS_URL, CHANNELS_API_KEY
```

## Email como authenticator (Fase 2)

Nada de JWT on-chain: o `auth-issuer` valida o email (OTP) e emite uma
attestation Ed25519 curta cujo `challenge` é o **auth digest exato da
transação** — replay em outra transação, rede ou seleção de regra é inválido
por construção, herdando o anti-replay do protocolo. O
`email-attestation-verifier` verifica assinatura do issuer, subject, challenge
e expiração.

Regra de ouro: o email signer entra numa context rule `CallContract(alvo)`
separada — nunca na regra `Default` — então email sozinho não administra a
conta nem autoriza outros contratos (step-up com passkey continua obrigatório
para operações sensíveis).

```bash
cd services/auth-issuer && npm install && npm run dev   # emissor em :8788
npm run fixture   # regenera o vetor cross-language dos testes Rust
```

## Desenvolvimento

Contratos (Rust/Soroban, requer stellar-cli ≥ 25.2 e target `wasm32v1-none`):

```bash
cargo test --workspace     # testes (inclui e2e de __check_auth)
stellar contract build     # WASM em target/wasm32v1-none/release/
```

Cliente:

```bash
cd client && npm install && npm run dev
```

O cliente vem configurado com os contratos oficiais do smart-account-kit já
implantados no testnet (Protocol 27). Para usar o WASM deste repositório, faça
`stellar contract upload` e troque `accountWasmHash` em `client/src/config.ts`.

## Session keys (Fase 4)

Depois de um login forte com passkey, a conta autoriza uma chave Ed25519
efêmera (memória do browser, sem persistência) com três guarda-corpos
on-chain, todos aplicados em `__check_auth`:

- **Escopo**: context rule `CallContract(alvo)` — a sessão só fala com um
  contrato e, por construção, não administra a conta;
- **Expiração**: `valid_until` em ledgers — a sessão morre sozinha;
- **Valor**: [spending-limit-policy](contracts/spending-limit-policy/src/contract.rs)
  — teto de gasto em janela deslizante de ledgers.

O cliente ([session.ts](client/src/session.ts)) expõe `grantSession` (um
prompt de passkey), `transferWithSession` (zero prompts) e `revokeSession`.

## Roadmap

1. **Fase 1** — MetaAccount + passkey + cliente web. ✅
2. **Fase 2** — email como attestation off-chain assinada (issuer service),
   verificada em `__check_auth`, com challenge = auth digest da transação. ✅
3. **Fase 3** — treasury/paymaster híbrido: contrato Treasury (orçamento +
   quotas auditáveis) + relayer-proxy com policy na frente da submissão. ✅
4. **Fase 4** — session keys como context rules `CallContract` com
   `valid_until` curto e spending-limit policy. ✅
5. **Fase 5** — recovery: guardians + timelock + step-up auth.

[`stellar-accounts`]: https://github.com/OpenZeppelin/stellar-contracts
[`smart-account-kit`]: https://github.com/kalepail/smart-account-kit

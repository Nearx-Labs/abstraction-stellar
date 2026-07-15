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
client/                        # web app (Vite + TS + smart-account-kit)
services/
  auth-issuer/                 # emissor off-chain de attestations (OTP por email)
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

## Roadmap

1. **Fase 1** — MetaAccount + passkey + cliente web. ✅
2. **Fase 2** — email como attestation off-chain assinada (issuer service),
   verificada em `__check_auth`, com challenge = auth digest da transação. ✅
3. **Fase 3** — treasury/paymaster: policy de quota on-chain
   (`stellar-fee-abstraction`) + OpenZeppelin Relayer self-hosted com camada
   de anti-abuse.
4. **Fase 4** — session keys como context rules `CallContract` com
   `valid_until` curto e spending-limit policy.
5. **Fase 5** — recovery: guardians + timelock + step-up auth.

[`stellar-accounts`]: https://github.com/OpenZeppelin/stellar-contracts
[`smart-account-kit`]: https://github.com/kalepail/smart-account-kit

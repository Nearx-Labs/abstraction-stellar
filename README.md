# Abstraction

<video src="demo/abstraction-demo.mp4" controls muted width="100%"></video>

[▶️ Demo em vídeo (57s)](demo/abstraction-demo.mp4)

Generalized abstraction na Stellar: smart accounts com login por passkey, sem
seed phrase e com taxas patrocinadas — o modelo da Xion portado para o desenho
nativo de Stellar/Soroban.

Roda como **três serviços**: um front onde o criador configura a carteira
gasless, uma API que patrocina as transações, e Postgres.

```bash
cp .env.example .env
./dev.sh                 # db no docker + back :8080 + front :5173
```

Ou tudo em container:

```bash
docker compose up --build
```

## Arquitetura

```
apps/
  front/            web app (Vite + React + Tailwind): passkey, faucet, cota, session keys
  back/             API única (Hono + Postgres): relayer patrocinado, registry,
                    faucet, session keys, emissor de attestations de email
contracts/
  meta-account/                # a smart account (CustomAccountInterface + SmartAccount)
  webauthn-verifier/           # verificador de assertions WebAuthn (passkey)
  ed25519-verifier/            # verificador Ed25519 (session keys / admin)
  email-attestation-verifier/  # verificador de attestations de email (Fase 2)
  treasury/                    # policy on-chain do paymaster (Fase 3)
  spending-limit-policy/       # teto de gasto em janela deslizante (Fase 4)
```

- **On-chain** — contract account (`MetaAccount`) construída sobre o framework
  de smart accounts da OpenZeppelin ([`stellar-accounts`]). A autorização é
  organizada em *context rules*: cada regra vincula signers (passkeys WebAuthn,
  Ed25519, endereços delegados) e policies (spending limit, threshold) a um
  escopo (`Default`, `CallContract`, `CreateContract`).
- **Cliente** — [`smart-account-kit`]: cria a passkey, deriva e implanta a
  conta, assina e submete transações.
- **Fees** — patrocinadas por um pool de contas pagadoras, com policy e quota
  antes da submissão e débito auditável no Treasury.

Anti-replay, expiração de assinatura e binding de rede/invocação são nativos do
protocolo (nonce do `SorobanAuthorizationEntry`, consumido pelo host); o
contrato verifica provas e aplica policies. Os signers assinam
`sha256(signature_payload || context_rule_ids.to_xdr())`, o que impede ataques
de downgrade de regra.

## A API

Base `/v1`. Erros sempre `{success, error, errorCode}`.

### Relay — o endpoint que o kit chama

```
POST /v1/relay/:publishableKey     {func, auth} | {xdr}
```

A chave vai no **path**, não num header: o `RelayerClient` do smart-account-kit
monta o fetch com `Content-Type` + `X-Client-Name` + `X-Client-Version` e nada
mais, e posta na URL exata configurada em `relayerUrl`. Não existe gancho para
`Authorization`, cookie ou header customizado.

A publishable key é pública por construção. Quem segura o gasto é a combinação
allowlist de alvos + teto por transação + quota diária por conta + allowance
on-chain; a chave serve para rotear ao app e cortar origem desconhecida.

> **CORS**: `X-Client-Name` e `X-Client-Version` não são headers simples, então
> disparam preflight. Esquecê-los no `allowHeaders` quebra 100% das chamadas do
> kit.

### Painel — sessão por passkey (cookie httpOnly)

| | |
|---|---|
| `POST /v1/accounts` | registra a conta (aceita publishable key ou secret key) |
| `POST /v1/authn/challenge` · `/verify` · `/logout` | abre e fecha a sessão do painel |
| `GET /v1/accounts/:address` | saldo, status, allowance |
| `GET /v1/accounts/:address/usage` | cota do dia, off-chain e on-chain |
| `POST` `GET /v1/accounts/:address/faucet` | XLM de testnet + ativação da cota |
| `POST /v1/accounts/:address/faucet/allowance` | reenvia só a perna da allowance |
| `GET` `POST /v1/accounts/:address/sessions` · `DELETE /:ruleId` | session keys |
| `GET /v1/accounts/:address/sponsorships` | histórico de patrocínios |

### Servidor-a-servidor — `Authorization: Bearer sk_…`

Mesmos handlers, autenticação diferente. `external_id` amarra o usuário do
sistema consumidor à smart account:

```bash
curl -X POST $API/v1/accounts -H "Authorization: Bearer sk_…" \
  -d '{"contractId":"C…","externalId":"user-42"}'

curl "$API/v1/accounts?externalId=user-42" -H "Authorization: Bearer sk_…"
```

### Email como authenticator (Fase 2)

`POST /v1/email/request` · `/verify` · `/attest`. Nada de JWT on-chain: o
serviço valida o email (OTP) e emite uma attestation Ed25519 curta cujo
`challenge` é o **auth digest exato da transação** — replay em outra transação,
rede ou seleção de regra é inválido por construção. O
`email-attestation-verifier` verifica assinatura do issuer, subject, challenge
e expiração.

Regra de ouro: o email signer entra numa context rule `CallContract(alvo)`
separada — nunca na `Default` — então email sozinho não administra a conta.

Não tem UI. O que garante que continua funcionando é
[`test/email-flow.test.ts`](apps/back/test/email-flow.test.ts), que roda o fluxo
inteiro e compara o encoding contra o vetor lido por `include_str!` no teste
Rust do verificador. O CI falha se os dois divergirem.

## Fee abstraction

Modelo híbrido, sponsor-pays: o usuário nunca toca em XLM.

**On-chain** ([treasury](contracts/treasury/src/contract.rs)) — a camada
declarativa e auditável: orçamento do sponsor em token SEP-41, allowlist de
contratos patrocináveis e allowance por usuário (`max_per_tx`, `max_per_day`,
expiração). Cada patrocínio é debitado via `consume`, que emite evento.

**Off-chain** ([apps/back](apps/back)) — o enforcement operacional:

- **quota atômica no Postgres.** Reserva-se o teto que a transação pode custar;
  na liquidação devolve-se o teto e cobra-se o `feeCharged` real. A reserva é um
  `UPDATE … WHERE reserved + settled + valor <= teto`: o lock de linha do
  Postgres reavalia o `WHERE` contra a versão já atualizada, então a soma nunca
  passa do teto — com uma réplica ou com dez.
- **pool de contas pagadoras com lease** (`FOR UPDATE SKIP LOCKED`), que resolve
  a corrida de sequence number. Só o caminho `{func, auth}` precisa disso: um
  fee-bump não consome o sequence do `feeSource`.
- **outbox** para tudo que escreve no Treasury, com retry exponencial e
  deduplicação. Débito que falha é retentado, não some.
- **allowlist obrigatória**, idempotência por `Idempotency-Key`, rate limit por
  IP e por conta.

Limite conhecido: `consume` exige o `operator` e o contrato guarda um só, e
Soroban aceita uma `invokeHostFunction` por transação — então não dá para
batchear débitos. O teto prático é ~1 débito por ledger (~17k/dia). Passar disso
exige `consume` aceitar um `Vec`, o que significa redeploy.

## Faucet (testnet)

O botão faz duas coisas numa ação:

1. **XLM na smart account.** O friendbot não financia contract address — ele só
   cria contas clássicas. O caminho é transferir pelo SAC a partir da conta de
   faucet da plataforma.
2. **Allowance no Treasury.** `set_allowance` é `#[only_owner]`, e nada no
   projeto chamava essa função: toda conta nova falhava o débito com
   `NoAllowance (5101)`, em silêncio. Ativar a cota aqui é o que fecha isso.

A segunda perna vai pelo outbox, então o cliente não espera dois blocos e a
escrita é retentada se falhar. Cooldown e claim em voo são garantidos por índice
único no banco — duplo clique e dois pods caem no mesmo lugar.

```bash
cd apps/back && npm run bootstrap    # diagnostica owner, operator, allowlist, orçamento e saldo
```

O `bootstrap` não adivinha: quando a chave do serviço não é a dona do Treasury,
ele imprime o comando exato do `stellar` CLI para resolver. O Treasury **não tem
`upgrade`**, então criar um papel "provisioner" que possa `set_allowance` sem
poder sacar exigiria redeploy — é o follow-up antes da mainnet.

## Session keys (Fase 4)

Depois de um login forte com passkey, a conta autoriza uma chave Ed25519
efêmera com três guarda-corpos on-chain, todos aplicados em `__check_auth`:

- **Escopo**: context rule `CallContract(alvo)` — a sessão só fala com um
  contrato e, por construção, não administra a conta;
- **Expiração**: `valid_until` em ledgers — a sessão morre sozinha;
- **Valor**: [spending-limit-policy](contracts/spending-limit-policy/src/contract.rs).

A chave privada vive só na aba do browser. A tela diz isso em voz alta: recarregar
a página não invalida a regra on-chain, mas você perde a chave — o caminho passa a
ser revogar. Um worker reconcilia o registro contra `get_context_rule`, então
sessão revogada por fora aparece como tal.

## Recovery e multi-device (Fase 5)

Sem seed phrase, a perda de devices precisa de dois planos:

1. **Multi-device (primeira linha)** — registrar mais de uma passkey na regra
   Default (`add_signer`/`batch_add_signer`).
2. **Guardians + timelock ([recovery.rs](contracts/meta-account/src/recovery.rs))**
   — quórum de guardians aprova a instalação de um novo autenticador. O
   `finalize` só executa após o timelock, é permissionless e cria uma **nova**
   regra Default. Durante o timelock, **qualquer autenticador vivo veta**
   (`cancel_recovery`). Guardians nunca movimentam fundos.

Contratos e testes prontos; ainda sem UI.

## Desenvolvimento

Contratos (Rust/Soroban, requer stellar-cli ≥ 25.2 e target `wasm32v1-none`):

```bash
cargo test --workspace     # 42 testes, inclui e2e de __check_auth
stellar contract build
```

Serviços:

```bash
cd apps/back  && npm install && npm run dev    # :8080
cd apps/front && npm install && npm run dev    # :5173
cd apps/back  && npm test                      # quota sob concorrência + fluxo de email
```

Em desenvolvimento nada precisa ser configurado à mão: o back migra o banco no
boot, cria o app `demo` com `pk_test_dev`/`sk_test_dev`, deriva as chaves de
serviço de forma determinística e as financia no friendbot. Fora de
`NODE_ENV=development` o processo **não sobe** sem os segredos — de propósito:
os defaults antigos (fee payer efêmero do friendbot, chave de emissor igual à do
fixture de teste) eram armadilhas silenciosas.

## Roadmap

1. **Fase 1** — MetaAccount + passkey + cliente web. ✅
2. **Fase 2** — email como attestation off-chain assinada, verificada em
   `__check_auth`, com challenge = auth digest da transação. ✅
3. **Fase 3** — treasury/paymaster híbrido + policy antes da submissão. ✅
4. **Fase 4** — session keys como context rules `CallContract` com
   `valid_until` curto e spending-limit policy. ✅
5. **Fase 5** — recovery: guardians + threshold + timelock + veto do dono +
   cooldown; multi-device como primeira linha. ✅
6. **Produto** — três serviços deployáveis, estado no Postgres, front do
   criador com faucet, API multi-tenant. ✅

[`stellar-accounts`]: https://github.com/OpenZeppelin/stellar-contracts
[`smart-account-kit`]: https://github.com/kalepail/smart-account-kit

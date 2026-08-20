# Abstraction

<video src="demo/abstraction-demo.mp4" controls muted width="100%"></video>

[▶️ Demo em vídeo (57s)](demo/abstraction-demo.mp4)

Generalized abstraction na Stellar: smart accounts com login por passkey, sem
seed phrase e com taxas patrocinadas — o modelo da Xion portado para o desenho
nativo de Stellar/Soroban.

Roda como **três serviços**: um front onde o criador opera a conta, uma API que
patrocina as transações e Postgres.

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
  front/            web app (Vite + React + Tailwind)
  back/             API única (Hono + Postgres)
packages/
  client/           cliente tipado, gerado da spec OpenAPI
contracts/
  meta-account/                # a smart account (CustomAccountInterface + SmartAccount)
  webauthn-verifier/           # verificador de assertions WebAuthn (passkey)
  ed25519-verifier/            # verificador Ed25519 (chave do app / do serviço)
  email-attestation-verifier/  # verificador de attestations de email
  treasury/                    # policy on-chain do paymaster
  spending-limit-policy/       # teto de VALOR numa janela deslizante
  mint-quota-policy/           # teto de VOLUME numa janela deslizante
  demo-ledger/                 # inventário de itens por UUID
```

A autorização é organizada em *context rules*: cada regra vincula signers
(passkeys WebAuthn, Ed25519, endereços delegados) e policies a um escopo
(`Default`, `CallContract`, `CreateContract`).

Anti-replay, expiração de assinatura e binding de rede/invocação são nativos do
protocolo (nonce do `SorobanAuthorizationEntry`, consumido pelo host). Os
signers assinam `sha256(signature_payload || context_rule_ids.to_xdr())`, o que
impede ataques de downgrade de regra — pegar uma assinatura feita sob a regra
restrita e reapresentá-la sob a `Default`.

### Contratos no testnet

| | |
|---|---|
| Treasury (paymaster) | `CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV` |
| WebAuthn verifier | `CBQGQXWD6GSCPMP32JRPRPXPNHEN7PWEUI6LXOQZ2HWODO6ZAXRG3SPI` |
| Ed25519 verifier | `CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ` |
| Email attestation verifier | `CDW2NDHXXVZB7PMIIBISBBJKBX6AM77CXX5TVH66PUGERZM5JPCDJWKM` |
| Spending-limit policy | `CC3GRDE3QDLXFOZJMC6SNZHRKWGQXELANBJWS6T3H7GO77K4NRKFUIDT` |
| Mint-quota policy | `CCKCKDXEWD3LHSZT3OLTJTRFNMXPQPONKUPQPQJ2CAXFVNACJDFAYWVJ` |
| Demo ledger | `CCBGDWXPHXPGYJL2T4GDIF6PAGZ3XVYFR67HBFQ5RVJXGNMT5KGCUD5G` |

## O grant de app

O usuário **não** confirma cada transação com a digital. Ele aprova uma vez o
que o app pode fazer, e o app assina sozinho dentro daquilo — o modelo de grant
de conta abstrata.

Um grant é uma context rule `CallContract(alvo)` que autoriza uma chave Ed25519
guardada no navegador, com uma policy instalada. Ele é definido por **escopo** e
**limite**, não por prazo: quem o encerra é a revogação.

- **escopo** — fala com UM contrato e, por construção, não administra a conta:
  adicionar signer, mexer em regra e iniciar recovery ficam fora;
- **limite** — teto numa janela deslizante que se renova sozinha, o análogo de
  uma allowance periódica;
- **prazo** — opcional, para quem quiser um grant temporário.

Um grant por contrato, e não um só para tudo, porque `CallContract` recebe um
endereço: um grant abrangente seria a regra `Default`, e aí a chave do app
poderia administrar a conta.

**Qual policy vai em qual contrato importa.** A spending-limit só sabe
metrificar `transfer`; sob uma regra com ela instalada, qualquer outra função
morre em `NotAllowed (3223)`. Contrato de token leva spending-limit (teto de
valor); contrato que não é token leva mint-quota (teto de volume).

A chave do app fica em `localStorage` — legível por XSS. O que limita o estrago
é o próprio grant: um contrato, teto por janela, revogável. É a troca que
qualquer grant de dApp faz.

## A API

Base `/v1`. Erros sempre `{success, error, errorCode}` — o `errorCode` é o
contrato estável; a mensagem é para humano.

A especificação OpenAPI 3.1 é servida pelo próprio serviço, então o que se lê é
o que o processo está rodando:

| | |
|---|---|
| `GET /openapi.json` | a spec |
| `GET /docs` | referência navegável |
| [`apps/back/openapi.json`](apps/back/openapi.json) | a mesma spec versionada, para gerar cliente |

```bash
cd apps/back && npm run openapi:export
```

Para consumir de outro serviço TypeScript há um cliente pronto em
[`packages/client`](packages/client) — tipos gerados da spec, ESM e CommonJS,
sem dependência de runtime:

```ts
const abstraction = new AbstractionClient({ baseUrl, secretKey });

const { account } = await abstraction.accounts.byExternalId('user-42');
const { minted, failed } = await abstraction.mintAll({ uuids, name, fields });
```

A spec é escrita à mão — o Hono não tem decorators. O que impede o
apodrecimento é [`test/openapi.test.ts`](apps/back/test/openapi.test.ts), que
compara o documento com as rotas **realmente registradas** (`app.routes`): rota
nova sem documentação, ou documentação de rota que não existe mais, quebra o
CI. O documento também é validado por linter no CI.

### Relay — o endpoint que o kit chama

```
POST /v1/relay/:publishableKey     {func, auth} | {xdr}
```

A chave vai no **path**, não num header: o `RelayerClient` do smart-account-kit
monta o fetch com `Content-Type` + `X-Client-Name` + `X-Client-Version` e nada
mais, e posta na URL exata configurada em `relayerUrl`.

A publishable key é pública por construção. Quem segura o gasto é a combinação
allowlist de alvos + teto por transação + quota diária por conta + allowance
on-chain.

> **CORS**: `X-Client-Name` e `X-Client-Version` não são headers simples, então
> disparam preflight. Esquecê-los no `allowHeaders` quebra 100% das chamadas do
> kit.

### Painel — sessão por passkey (cookie httpOnly)

| | |
|---|---|
| `POST /v1/accounts` | registra a conta |
| `POST /v1/authn/challenge` · `/verify` · `/logout` | sessão do painel |
| `GET /v1/accounts/:address` | saldo, status, allowance |
| `GET /v1/accounts/:address/usage` | cota do dia, off-chain e on-chain |
| `POST` `GET /v1/accounts/:address/faucet` | XLM de testnet + ativação da cota |
| `GET` `POST` `DELETE /v1/accounts/:address/sessions` | grants do app |
| `GET /v1/accounts/:address/sponsorships` | histórico de patrocínios |

### Conta mestre e ledger — `Authorization: Bearer sk_…`

| | |
|---|---|
| `GET` `POST /v1/master` | conta mestre do tenant e chave do serviço |
| `POST` `DELETE /v1/master/grant` | permissão concedida ao serviço |
| `POST /v1/ledger/mint` | minta um lote como a conta mestre |
| `POST /v1/ledger/transfer` | venda: passa a posse de um item |
| `GET /v1/ledger` · `/v1/ledger/:uuid` | o ledger, lido on-chain |
| `GET /v1/ledger/entries` | o payload completo dos eventos |

`external_id` amarra o usuário do sistema consumidor à smart account:

```bash
curl -X POST $API/v1/accounts -H "Authorization: Bearer sk_…" \
  -d '{"contractId":"C…","externalId":"user-42"}'
```

### Email como authenticator

`POST /v1/email/request` · `/verify` · `/attest`. Nada de JWT on-chain: o
serviço valida o email (OTP) e emite uma attestation Ed25519 curta cujo
`challenge` é o **auth digest exato da transação** — replay em outra transação,
rede ou seleção de regra é inválido por construção.

O email signer entra numa context rule `CallContract(alvo)` separada — nunca na
`Default` — então email sozinho não administra a conta.

Não tem UI. O que garante que continua funcionando é
[`test/email-flow.test.ts`](apps/back/test/email-flow.test.ts), que roda o fluxo
inteiro e compara o encoding contra o vetor lido por `include_str!` no teste
Rust do verificador. O CI falha se os dois divergirem.

## NFT por UUID

A conta mestre de um tenant minta um lote e fica dona de todos. Cada item é
identificado por um **UUID gerado fora da chain** — a mesma chave que o banco do
sistema consumidor guarda, então os dois lados falam do mesmo item sem tabela de
conversão. Cada item carrega campos livres definidos por quem minta.

A venda no marketplace é um `transfer(uuid, comprador)`: a posse corrente fica
on-chain e qualquer um verifica quem detém o quê. O campo `minter` não muda —
é como se sabe de qual tenant o item saiu.

`mint_batch` aceita até 100 itens por transação: não é escolha de desenho, é o
limite de recursos de uma transação Soroban. Um inventário de 10.000 sai em
~100 transações patrocinadas.

O contrato guarda referência de mídia, não arquivo — um Soroban cobra por byte
armazenado.

### O teto que o tenant concede

Para o serviço mintar sem passkey, o tenant concede uma regra
`CallContract(demo-ledger)` com um signer Ed25519 que a API detém e a
mint-quota-policy instalada com o número de itens autorizado.

A cota conta **itens, não transações**: a policy lê os argumentos e desconta o
tamanho do lote, então autorizar "10.000 NFTs" significa 10.000 itens. Um lote
maior que o teto é recusado **inteiro**, não parcialmente.

A chave Ed25519 do serviço não é guardada: é derivada de `MASTER_SIGNER_SEED` +
`app_id`. Não há segredo em repouso no Postgres, e a chave é reconstruível em
qualquer réplica. O banco guarda só a pública, para conferir que o grant
on-chain aponta para a chave que o processo realmente tem.

## Fee abstraction

Modelo híbrido, sponsor-pays: o usuário nunca toca em XLM.

**On-chain** ([treasury](contracts/treasury/src/contract.rs)) — a camada
declarativa e auditável: orçamento do sponsor em token SEP-41, allowlist de
contratos patrocináveis e allowance por usuário. Cada patrocínio é debitado via
`consume`, que emite evento.

**Off-chain** ([apps/back](apps/back)) — o enforcement operacional:

- **quota atômica no Postgres.** Reserva-se o teto que a transação pode custar;
  na liquidação devolve-se o teto e cobra-se o `feeCharged` real. A reserva é um
  `UPDATE … WHERE reserved + settled + valor <= teto`: o lock de linha reavalia
  o `WHERE` contra a versão já atualizada, então a soma nunca passa do teto —
  com uma réplica ou com dez.
- **pool de contas pagadoras com lease** (`FOR UPDATE SKIP LOCKED`), que resolve
  a corrida de sequence number. Só o caminho `{func, auth}` precisa disso: um
  fee-bump não consome o sequence do `feeSource`.
- **outbox** para tudo que escreve no Treasury, com retry exponencial e
  deduplicação. `NoAllowance` não mata o job — é condição temporária que o
  reconciliador conserta.
- **allowlist obrigatória**, idempotência, rate limit por IP e por conta.

O deploy de conta é medido como qualquer outra operação: o alvo e o pagador
saem do `contractIdPreimage`, já que a host function `createContract` não tem
alvo invocado nem credencial `Address`. A conta recebe allowance no próprio
deploy, então nasce podendo transacionar.

Limite conhecido: `consume` exige o `operator` e o contrato guarda um só, e
Soroban aceita uma `invokeHostFunction` por transação — não dá para batchear
débitos. O teto prático é ~1 débito por ledger (~17k/dia).

## Faucet (testnet)

O botão faz duas coisas numa ação:

1. **XLM na smart account.** O friendbot não financia contract address — ele só
   cria contas clássicas. O caminho é transferir pelo SAC a partir da conta de
   faucet da plataforma.
2. **Allowance no Treasury.** `set_allowance` é `#[only_owner]`; sem ela o
   débito falha com `NoAllowance (5101)`.

A segunda perna vai pelo outbox, então o cliente não espera dois blocos.
Cooldown e claim em voo são garantidos por índice único no banco — duplo clique
e dois pods caem no mesmo lugar.

```bash
cd apps/back && npm run bootstrap    # diagnostica owner, operator, allowlist, orçamento, saldo
```

O `bootstrap` não adivinha: quando a chave do serviço não é a dona do Treasury,
ele imprime o comando exato do `stellar` CLI.

## Recovery e multi-device

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
cargo test --workspace     # 67 testes
stellar contract build
```

Serviços:

```bash
cd apps/back  && npm install && npm run dev    # :8080
cd apps/front && npm install && npm run dev    # :5173
cd apps/back  && npm test                      # quota sob concorrência, email, kit internals
```

Em desenvolvimento nada precisa ser configurado à mão: o back migra o banco no
boot, cria o app `demo` com `pk_test_dev`/`sk_test_dev`, deriva as chaves de
serviço de forma determinística e as financia no friendbot. Fora de
`NODE_ENV=development` o processo **não sobe** sem os segredos.

### Duas armadilhas que o CI vigia

Ambas produzem erros que não apontam para a causa, e as duas já morderam:

- **`npm run check-sdk`** — duas cópias do `@stellar/stellar-sdk` fazem o `Spec`
  do contrato rejeitar os ScVal que o app constrói, porque a conversão checa o
  construtor do valor. O erro que sai é `cannot interpret n3 value as ScVal`.
- **`npm run check-args`** — campos tipados como `Val` no contrato (policies de
  uma context rule, `target_args` de um `execute`) só aceitam ScVal pronto.
  Objeto simples dá `Received object … did not match the provided type`, e é o
  que o próprio helper `createSpendingLimitParams` do kit devolve.

## Antes da mainnet

- **Recalibrar os tetos de fee.** Os valores atuais saem do custo medido no
  testnet (~1,02 XLM para criar uma context rule). Em mainnet as fees são bem
  menores.
- **Tirar a chave do owner do Treasury da API.** `set_allowance` é
  `#[only_owner]` e o contrato não tem `upgrade`, então criar um papel
  `provisioner` que provisione mas não saque exige redeploy.
- **Alertar saldo das contas de serviço.** Se o XLM acabar, o patrocínio para
  em silêncio. O worker já registra, falta o alerta.

## Roadmap

1. **Fase 1** — MetaAccount + passkey + cliente web. ✅
2. **Fase 2** — email como attestation off-chain assinada. ✅
3. **Fase 3** — treasury/paymaster híbrido + policy antes da submissão. ✅
4. **Fase 4** — grant de app com escopo, limite e revogação. ✅
5. **Fase 5** — recovery: guardians + threshold + timelock + veto + cooldown. ✅
6. **Produto** — três serviços deployáveis, NFT por UUID com venda on-chain,
   conta mestre por tenant com teto concedido. ✅

[`stellar-accounts`]: https://github.com/OpenZeppelin/stellar-contracts
[`smart-account-kit`]: https://github.com/kalepail/smart-account-kit

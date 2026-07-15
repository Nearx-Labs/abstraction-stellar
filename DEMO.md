# Roteiro de demo — Abstraction MVP (testnet)

> **Pitch de 30 segundos**: conta Stellar sem seed phrase, sem extensão de
> wallet e sem o usuário nunca tocar em XLM. Login com a digital (passkey),
> taxas pagas pelo sponsor com quota auditável on-chain, sessões temporárias
> para UX fluida e recuperação de conta por guardians. É o modelo de
> "generalized abstraction" da Xion, portado para o desenho nativo de
> Stellar/Soroban sobre o framework auditado da OpenZeppelin.

## Antes da reunião (5 min)

```bash
cd ~/Desktop/Abstraction
./start-demo.sh        # sobe issuer :8788, relayer :8787 e app :5173
```

Abra http://localhost:5173 no Chrome/Safari (passkey usa o Touch ID de
verdade — bom efeito na demo). Confirme os serviços:

```bash
curl -s localhost:8787/health | jq   # relayer + policy + treasury
curl -s localhost:8788/health | jq   # emissor de attestations
```

## Roteiro (10–15 min)

### 1. Onboarding sem seed phrase (~2 min)

1. Clique **"Criar conta com passkey"** → Touch ID → conta criada.
2. Fale: *"nenhuma seed phrase, nenhuma extensão. A credencial é uma passkey
   no Secure Enclave do device, e a conta é um smart contract próprio na
   Stellar, implantado agora"*.
3. Mostre a conta no explorer:
   `https://stellar.expert/explorer/testnet/contract/<endereço exibido no app>`

### 2. Transação sem gás (~3 min) — o coração da demo

1. Clique **"Enviar 1 XLM (fee patrocinada)"** → Touch ID → hash na tela.
2. Fale: *"o usuário assinou com a digital; quem pagou a taxa foi o nosso
   relayer, dentro de uma policy: allowlist de contratos, teto por transação
   e quota diária por conta"*.
3. Prova auditável on-chain — o débito no Treasury:
   ```bash
   stellar contract invoke --id CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV \
     --source demo --network testnet -- get_usage_today --user <conta do app>
   ```
   e a quota do lado do relayer:
   ```bash
   curl -s localhost:8787/quota/<conta do app> | jq
   ```
4. Se quiser dramatizar a policy: derrube a quota (`MAX_FEE_PER_DAY=1000` no
   start-demo.sh, reinicie) e mostre a transação sendo **recusada** com
   `FEE_LIMIT_EXCEEDED`.

### 3. Sob o capô (~3 min)

- Transação no explorer (hash da tela): mostre que é **fee-bump/source do
  relayer** — o usuário não tem sequer uma conta G clássica.
- Treasury no explorer: eventos `fee_consumed` públicos — *"o gasto do
  sponsor é auditável por qualquer um"*.
- README com o diagrama da arquitetura (1 contrato de conta + 3
  verificadores plugáveis + treasury + 2 serviços).

### 4. As fases sem UI: mostrar pelos testes (~3 min)

*"Tudo que não está na tela está provado por teste de integração contra o
contrato real"*:

```bash
cargo test --workspace   # 42 testes
```

Destaque três nomes de teste (grep no output):
- `check_auth_with_email_attestation_succeeds` — login por email vira um
  authenticator com desafio vinculado à transação exata (anti-replay do
  protocolo), e `email_rule_does_not_authorize_other_contract` prova que
  email sozinho não administra a conta.
- `session_key_authorizes_within_spending_limit` — sessões temporárias:
  300+200 passam num teto de 500, +1 stroop falha; expiração por ledger e
  revogação nos testes vizinhos.
- `full_recovery_flow_restores_control` — perdeu o celular: 2 de 3
  guardians + timelock reinstalam acesso, e `owner_veto_cancels_takeover`
  prova que quem ainda tem um device sempre vence um takeover.

### 5. Fechamento (~1 min)

- *"Base auditada (OpenZeppelin stellar-accounts), 42 testes, 6 contratos
  no testnet, protocolo compatível com o relayer de produção da OZ
  (Channels). O caminho para produção é: UI dos fluxos de email/sessão/
  recovery, observabilidade no relayer e auditoria dos contratos."*

## Endereços implantados (testnet, 2026-07-15)

| Contrato | Endereço |
|---|---|
| meta-account (wasm hash) | `750df2a268be9743d390ef65a496d9013df5c66127212be70cb856c55b426daa` |
| webauthn-verifier | `CBQGQXWD6GSCPMP32JRPRPXPNHEN7PWEUI6LXOQZ2HWODO6ZAXRG3SPI` |
| ed25519-verifier | `CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ` |
| email-attestation-verifier | `CDW2NDHXXVZB7PMIIBISBBJKBX6AM77CXX5TVH66PUGERZM5JPCDJWKM` |
| spending-limit-policy | `CC3GRDE3QDLXFOZJMC6SNZHRKWGQXELANBJWS6T3H7GO77K4NRKFUIDT` |
| treasury | `CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV` |
| XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

Identidades do stellar CLI: `demo` (owner do treasury) e `relayer`
(fee payer + operator). Treasury financiado com 100 XLM.

## Troubleshooting

- **Passkey não aparece**: use Chrome/Safari em `localhost` (contexto
  seguro). Firefox às vezes não expõe platform authenticator.
- **"alvo não é patrocinável"**: o contrato chamado não está em
  `TARGET_ALLOWLIST` do relayer (auto-invocação da conta é sempre liberada).
- **Conta "sumiu" após semanas**: estado archivado no testnet — restaure com
  `stellar contract restore` ou crie outra conta (é um demo).
- **Testnet reset trimestral**: os endereços acima morrem; rode o deploy de
  novo (seção "Desenvolvimento" do README) e atualize `client/src/config.ts`
  + `start-demo.sh`.

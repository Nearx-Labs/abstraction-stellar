# @abstraction/client

Cliente tipado da Abstraction API — smart accounts na Stellar com taxas
patrocinadas.

Os tipos são **gerados** do `openapi.json` do serviço, não escritos à mão. Se a
API mudar, o que quebra é a compilação, não uma chamada em produção.

Sem dependência de runtime: usa o `fetch` nativo (Node ≥ 18). Sai em ESM e
CommonJS, então funciona com `import` e com `require`.

## Instalação

```bash
npm install @abstraction/client
```

## Uso

```ts
import { AbstractionClient } from '@abstraction/client';

const abstraction = new AbstractionClient({
  baseUrl: process.env.ABSTRACTION_URL!,
  secretKey: process.env.ABSTRACTION_SECRET_KEY!, // sk_…
});
```

### Amarrar um usuário do seu sistema a uma smart account

`externalId` é o id do usuário do **seu** lado. É o que evita manter uma tabela
de conversão.

```ts
await abstraction.accounts.register({
  contractId: 'C…',
  externalId: 'user-42',
});

const { account } = await abstraction.accounts.byExternalId('user-42');
```

### Inventário

```ts
const uuids = Array.from({ length: 10_000 }, () => crypto.randomUUID());

const { minted, failed } = await abstraction.mintAll({
  uuids,
  name: 'Ingresso — Turnê 2026',
  fields: { campanha: 'turne-2026', lote: 'pista' },
  onProgress: ({ minted, total }) => console.log(`${minted}/${total}`),
});
```

Cada lote é **uma transação**, com no máximo `MAX_BATCH` (100) itens — não é
escolha da biblioteca, é o teto de recursos de uma transação Soroban. Como uma
falha no meio deixa os lotes anteriores mintados, `mintAll` devolve o que passou
e o que não, em vez de estourar e perder o rastro.

Se a cota que o tenant concedeu acabar, ele **para** em vez de insistir: os
lotes seguintes falhariam igual, queimando fee.

### A venda

```ts
await abstraction.ledger.transfer({ uuid, to: 'C…' });
```

Depois da primeira venda quem autoriza é o comprador, não a conta mestre — daí
uma segunda transferência pela API responde `NOT_OWNER`.

### Erros

```ts
import { AbstractionError } from '@abstraction/client';

try {
  await abstraction.ledger.mint({ uuids, name });
} catch (error) {
  if (error instanceof AbstractionError) {
    if (error.code === 'QUOTA_EXCEEDED') { /* pedir mais cota ao tenant */ }
    if (error.retryable) { /* indisponibilidade passageira */ }
  }
}
```

O `code` é o contrato estável; a mensagem é para humano. Os principais:

| código | o que houve |
|---|---|
| `NO_GRANT` | o tenant ainda não autorizou o serviço a mintar |
| `QUOTA_EXCEEDED` | a cota de itens concedida acabou |
| `UUID_TAKEN` | um dos uuids já foi mintado |
| `NOT_OWNER` | a conta mestre não é mais a dona do item |
| `FEE_LIMIT_EXCEEDED` | cota de taxas patrocinadas do dia |
| `FAUCET_COOLDOWN` | faucet já usado no período |

### Retry

Só requisições **idempotentes** (GET) são retentadas automaticamente. Escritas
não: repetir um mint sem controle gastaria a cota do tenant. `mintAll` trata o
caso de lote explicitamente.

## Desenvolvimento

```bash
npm run generate   # regenera src/schema.d.ts do openapi.json do serviço
npm run build      # ESM + CJS + tipos
npm test
```

`src/schema.d.ts` é gerado — não edite. O CI confere que ele está em dia com a
spec.

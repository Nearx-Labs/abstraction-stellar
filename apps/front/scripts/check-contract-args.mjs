// Verifica que os argumentos que este app monta são aceitos pelo `Spec` do
// contrato — antes de descobrirmos isso com a passkey na mão.
//
// O `Spec` converte cada argumento pelo tipo declarado, e os campos tipados
// como `Val` (policies de uma context rule, target_args de um execute) NÃO têm
// conversão: objeto simples estoura "Received object … did not match the
// provided type", primitivo estoura "invalid type scSpecTypeVal". Só passa
// ScVal pronto — e da MESMA cópia do stellar-sdk (ver check-sdk-dedupe.mjs).
//
// Duas regressões reais já vieram daqui, as duas com mensagem que não aponta
// para a causa. Este script é barato e fecha as duas portas.
import { contract, Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';

const bindings = new URL(
  '../node_modules/smart-account-kit/node_modules/smart-account-kit-bindings/dist/index.js',
  import.meta.url,
);
const spec = new contract.Spec(
  readFileSync(bindings, 'utf8')
    .match(/"([A-Za-z0-9+/=]{100,})"/g)
    .map((s) => s.slice(1, -1)),
);

const C = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const entry = (k, v) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

const cases = [
  {
    name: 'params da spending-limit-policy',
    run: () =>
      spec.funcArgsToScVals('add_context_rule', {
        context_type: { tag: 'CallContract', values: [C] },
        name: 'sessao',
        valid_until: 999_999,
        signers: [],
        policies: new Map([
          [
            C,
            xdr.scvSortedMap([
              entry('period_ledgers', nativeToScVal(720, { type: 'u32' })),
              entry('spending_limit', nativeToScVal(100_000_000n, { type: 'i128' })),
            ]),
          ],
        ]),
      }),
  },
  {
    name: 'params da mint-quota-policy',
    run: () =>
      spec.funcArgsToScVals('add_context_rule', {
        context_type: { tag: 'CallContract', values: [C] },
        name: 'mint do serviço',
        valid_until: undefined,
        signers: [],
        policies: new Map([
          [
            C,
            xdr.scvSortedMap([
              entry('max_items', nativeToScVal(10_000, { type: 'u32' })),
              entry('period_ledgers', nativeToScVal(17_280, { type: 'u32' })),
            ]),
          ],
        ]),
      }),
  },
  {
    name: 'args do mint via execute',
    run: () =>
      spec.funcArgsToScVals('execute', {
        target: C,
        target_fn: 'mint',
        target_args: [
          new Address(C).toScVal(),
          nativeToScVal('6f1c0b2e-1111-4000-8000-000000000001', { type: 'string' }),
          nativeToScVal('Ingresso', { type: 'string' }),
          nativeToScVal('', { type: 'string' }),
          xdr.scvSortedMap([
            entry('campanha', nativeToScVal('turne-2026', { type: 'string' })),
          ]),
        ],
      }),
  },
  {
    name: 'args do transfer via execute',
    run: () =>
      spec.funcArgsToScVals('execute', {
        target: C,
        target_fn: 'transfer',
        target_args: [
          nativeToScVal('6f1c0b2e-1111-4000-8000-000000000001', { type: 'string' }),
          new Address(C).toScVal(),
        ],
      }),
  },
];

let failed = 0;
for (const testCase of cases) {
  try {
    testCase.run();
    console.log(`  ok  ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FALHOU  ${testCase.name}\n          ${error.message}`);
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} conversão(ões) recusada(s) pelo Spec. Campos tipados como Val ` +
      'precisam de ScVal pronto (ver src/lib/policyParams.ts).',
  );
  process.exit(1);
}
console.log('argumentos de contrato: todos aceitos pelo Spec');

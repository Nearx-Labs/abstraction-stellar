// Parâmetros de instalação das policies, já em ScVal.
//
// O `policies` de `add_context_rule` é `Map<Address, Val>`, e o `Spec` do
// contrato não converte nada para `Val`: objeto simples cai em "Received object
// … did not match the provided type", e valor primitivo em "invalid type
// scSpecTypeVal". Só passa ScVal pronto.
//
// Isso vale inclusive para o `createSpendingLimitParams` do próprio kit, que
// devolve `{period_ledgers, spending_limit}` — um objeto simples. Por isso os
// params são montados aqui.
//
// A ordem das chaves importa: o host valida que o ScMap está ordenado, e
// `scvSortedMap` cuida disso.
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

const entry = (key: string, val: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

/**
 * `SpendingLimitAccountParams { spending_limit: i128, period_ledgers: u32 }`
 * — o teto de VALOR de uma session key.
 */
export function spendingLimitParams(
  spendingLimitStroops: bigint,
  periodLedgers: number,
): xdr.ScVal {
  return xdr.scvSortedMap([
    entry('period_ledgers', nativeToScVal(periodLedgers, { type: 'u32' })),
    entry('spending_limit', nativeToScVal(spendingLimitStroops, { type: 'i128' })),
  ]);
}

/**
 * `MintQuotaParams { max_items: u32, period_ledgers: u32 }`
 * — o teto de QUANTIDADE que um tenant concede ao serviço.
 */
export function mintQuotaParams(maxItems: number, periodLedgers: number): xdr.ScVal {
  return xdr.scvSortedMap([
    entry('max_items', nativeToScVal(maxItems, { type: 'u32' })),
    entry('period_ledgers', nativeToScVal(periodLedgers, { type: 'u32' })),
  ]);
}

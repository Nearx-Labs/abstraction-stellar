// Allowlist de quem pode escrever nos ledgers.
//
// O demo-ledger só aceita mint de quem está em `set_minter`, e o anchor-ledger
// só aceita registro de quem está em `set_writer` — sem isso qualquer conta
// mintava o UUID do consumidor antes dele, ou poluía o histórico de outro
// tenant. Quem mantém a lista é o `registrar` do contrato, que é a chave de
// owner deste serviço (ver keys.ts). O provisionamento habilita a mestre de
// cada tenant aqui, no mesmo passo em que concede os grants.
import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, server } from './rpc.js';
import { assertWithinFeeCap } from './feeCap.js';

/** Janela de validade da assinatura do registrar, em ledgers (~5 min). */
const SIGNATURE_TTL_LEDGERS = 60;

const ROLES = {
  minter: { set: 'set_minter', check: 'is_minter' },
  writer: { set: 'set_writer', check: 'is_writer' },
} as const;

export type LedgerRole = keyof typeof ROLES;

function invoke(contractId: string, fn: string, args: xdr.ScVal[]): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: fn,
      args,
    }),
  );
}

async function build(
  payer: Keypair,
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
) {
  return new TransactionBuilder(await server.getAccount(payer.publicKey()), {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(120)
    .build();
}

/** `is_minter` / `is_writer`, por simulação. */
export async function hasRole(
  contractId: string,
  role: LedgerRole,
  account: string,
  payer: Keypair,
): Promise<boolean> {
  const sim = await server.simulateTransaction(
    await build(payer, invoke(contractId, ROLES[role].check, [new Address(account).toScVal()]), []),
  );
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`leitura de ${ROLES[role].check} falhou em ${contractId}`);
  }
  return sim.result.retval.switch().name === 'scvBool' && sim.result.retval.b();
}

/**
 * Habilita `account` no ledger, se ainda não estiver. Idempotente.
 *
 * O channel paga e é o source da transação; o registrar só assina a auth
 * entry. Assim o registrar não consome sequence — não colide com o outbox do
 * Treasury, que usa a mesma chave de owner.
 */
export async function ensureRole(options: {
  contractId: string;
  role: LedgerRole;
  account: string;
  registrar: Keypair;
  payer: Keypair;
}): Promise<{ changed: boolean; hash: string | null }> {
  if (await hasRole(options.contractId, options.role, options.account, options.payer)) {
    return { changed: false, hash: null };
  }

  const func = invoke(options.contractId, ROLES[options.role].set, [
    new Address(options.account).toScVal(),
    xdr.ScVal.scvBool(true),
  ]);

  const simulated = await server.simulateTransaction(await build(options.payer, func, []));
  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(
      `${ROLES[options.role].set} recusado na simulação: ` +
        JSON.stringify((simulated as { error?: unknown }).error),
    );
  }

  const { sequence } = await server.getLatestLedger();
  const auth = await Promise.all(
    (simulated.result?.auth ?? []).map((entry) =>
      authorizeEntry(
        entry,
        options.registrar,
        sequence + SIGNATURE_TTL_LEDGERS,
        NETWORK_PASSPHRASE,
      ),
    ),
  );

  const prepared = await server.prepareTransaction(await build(options.payer, func, auth));
  assertWithinFeeCap(prepared);
  prepared.sign(options.payer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`${ROLES[options.role].set} rejeitado: ${JSON.stringify(sent.errorResult)}`);
  }
  const settled = await server.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  if (settled.status !== 'SUCCESS') {
    throw new Error(`${ROLES[options.role].set} não confirmou: status=${settled.status}`);
  }
  return { changed: true, hash: sent.hash };
}

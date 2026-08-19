// Assinatura como conta mestre, sem passkey.
//
// A conta mestre de um tenant é uma smart account cujo controle humano está na
// regra Default (passkey). Para o serviço mintar sozinho, o tenant concede uma
// segunda regra: `CallContract(demo-ledger)` com um signer Ed25519 que esta API
// detém e a mint-quota-policy instalada. Daí em diante o serviço assina — mas
// só aquele contrato, e só até o número de itens que o tenant autorizou.
//
// A chave Ed25519 NÃO é guardada em banco: ela é derivada de um segredo do
// processo mais o id do app. Assim não existe segredo em repouso no Postgres, e
// a chave é reconstruível em qualquer réplica.
import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { createHmac } from 'node:crypto';
import { env } from '../env.js';
import { NETWORK_PASSPHRASE, server } from './rpc.js';
import { authPayload } from './kitInternals.js';

/** Janela de validade da assinatura, em ledgers (~5 min). */
const SIGNATURE_TTL_LEDGERS = 60;

/**
 * Chave do serviço para um app. Determinística: mesmo segredo + mesmo app
 * reconstroem a mesma chave, em qualquer réplica e depois de qualquer restart.
 */
export function masterSignerFor(appId: string): Keypair {
  const seed = createHmac('sha256', env.MASTER_SIGNER_SEED).update(appId).digest();
  return Keypair.fromRawEd25519Seed(seed);
}

/** Identidade on-chain do signer: `External(ed25519Verifier, <pubkey 32B>)`. */
export function masterSignerIdentity(appId: string): {
  publicKeyHex: string;
  verifier: string;
} {
  return {
    publicKeyHex: masterSignerFor(appId).rawPublicKey().toString('hex'),
    verifier: env.ED25519_VERIFIER_ADDRESS,
  };
}

/**
 * Assina uma auth entry da conta mestre com a chave Ed25519 do serviço.
 *
 * O digest não é a signature payload crua: é
 * `sha256(signature_payload || context_rule_ids)`. Amarrar as regras ao que se
 * assina é o que impede um ataque de downgrade — pegar uma assinatura feita
 * para a regra restrita e reapresentá-la sob a regra Default.
 */
function signEntry(
  entry: xdr.SorobanAuthorizationEntry,
  contextRuleId: number,
  keypair: Keypair,
  expirationLedger: number,
): xdr.SorobanAuthorizationEntry {
  const credentials = authPayload.getAddressCredentials(entry.credentials());
  credentials.signatureExpirationLedger(expirationLedger);

  const signaturePayload = authPayload.buildSignaturePayload(
    NETWORK_PASSPHRASE,
    entry,
    expirationLedger,
  );
  const digest = authPayload.buildAuthDigest(signaturePayload, [contextRuleId]);
  const signature = keypair.sign(digest);

  const signerKey = authPayload.signerToScVal({
    tag: 'External',
    values: [env.ED25519_VERIFIER_ADDRESS, keypair.rawPublicKey()],
  });

  const payload = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('context_rule_ids'),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(contextRuleId)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signers'),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: signerKey, val: xdr.ScVal.scvBytes(signature) }),
      ]),
    }),
  ]);

  credentials.signature(payload);
  return entry;
}

export interface MasterInvokeResult {
  hash: string;
  status: string;
}

/**
 * Monta, autoriza e submete uma chamada feita pela conta mestre.
 *
 * O fluxo espelha o que o kit faz no browser, trocando a cerimônia WebAuthn por
 * uma assinatura Ed25519 local: simula para descobrir a árvore de autorização,
 * assina a entry da conta mestre, remonta e re-simula (a assinatura muda o
 * tamanho da transação, logo o custo), e submete pagando com um channel.
 */
export async function invokeAsMaster(options: {
  appId: string;
  masterAccount: string;
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
  contextRuleId: number;
  payer: Keypair;
}): Promise<MasterInvokeResult> {
  const keypair = masterSignerFor(options.appId);

  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(options.contractId).toScAddress(),
      functionName: options.fn,
      args: options.args,
    }),
  );

  const build = async (auth: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(await server.getAccount(options.payer.publicKey()), {
      fee: '1000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.invokeHostFunction({ func: hostFunction, auth }))
      .setTimeout(120)
      .build();

  // 1. Simula sem autorização para descobrir a árvore de auth que o host exige.
  const simulated = await server.simulateTransaction(await build([]));
  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(
      `simulação recusada: ${JSON.stringify((simulated as { error?: unknown }).error)}`,
    );
  }

  const { sequence } = await server.getLatestLedger();
  const expiration = sequence + SIGNATURE_TTL_LEDGERS;

  // 2. Assina a entry da conta mestre; as demais (se houver) passam intactas.
  const authEntries = (simulated.result?.auth ?? []).map((entry) =>
    authPayload.getAuthEntryAddress(entry) === options.masterAccount
      ? signEntry(entry, options.contextRuleId, keypair, expiration)
      : entry,
  );

  // 3. Re-simula: a assinatura entrou na transação e mudou o custo.
  const prepared = await server.prepareTransaction(await build(authEntries));
  prepared.sign(options.payer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`submissão rejeitada: ${JSON.stringify(sent.errorResult)}`);
  }

  const settled = await server.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  if (settled.status !== 'SUCCESS') {
    throw new Error(`transação não confirmou: status=${settled.status}`);
  }

  return { hash: sent.hash, status: settled.status };
}

// Provisionamento da conta mestre pelo próprio serviço — sem passkey.
//
// É o modelo custodial que o produto precisa: o tenant faz login social no
// portal e já encontra uma conta pronta, com as permissões concedidas. Ele não
// registra digital, não guarda seed phrase e não assina nada. O contrato da
// smart account nunca exigiu passkey — `__constructor(signers, policies)`
// aceita qualquer `Signer`, e WebAuthn era escolha do painel, não do protocolo.
//
// ## Duas chaves, e a razão de serem duas
//
//   · OWNER — vive na regra `Default`. Administra a conta: cria regra, remove
//     regra. Usada uma vez, no provisionamento, e depois fica parada.
//   · SERVIÇO — vive nas regras `CallContract(alvo)`, com a mint-quota-policy
//     instalada. É a que assina mint e âncora todo dia.
//
// Uma chave só faria o trabalho, e seria pior: a cota deixaria de ser fronteira.
// Como estão, a chave que opera no dia a dia não consegue alterar a regra que a
// limita, nem mover fundos, nem adicionar signer. Quem recusa não é este código
// — é o contrato.
//
// Ambas são DERIVADAS de `MASTER_SIGNER_SEED` + app. Nada em repouso no
// Postgres, e qualquer réplica reconstrói. O preço: trocar a seed invalida
// todas as contas já provisionadas, porque as chaves mudam e as regras
// on-chain apontam para as antigas.
import { Address, Keypair, Operation, TransactionBuilder, hash, rpc, xdr } from '@stellar/stellar-sdk';
import { createHmac } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { NETWORK_PASSPHRASE, server } from './rpc.js';
import { contractAddressFromPreimage } from './derive.js';
import { invokeAsMaster, masterSignerFor } from './masterSigner.js';

/** Chave que administra a conta. Derivada, como a do serviço, mas com rótulo próprio. */
export function ownerSignerFor(appId: string): Keypair {
  const seed = createHmac('sha256', env.MASTER_SIGNER_SEED)
    .update(`${appId}:owner`)
    .digest();
  return Keypair.fromRawEd25519Seed(seed);
}

/** `Signer::External(verificador, chave)` em ScVal. */
function signerScVal(keypair: Keypair): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    new Address(env.ED25519_VERIFIER_ADDRESS).toScVal(),
    xdr.ScVal.scvBytes(keypair.rawPublicKey()),
  ]);
}

/** `ContextRuleType::Default` / `::CallContract(alvo)` em ScVal. */
function contextTypeScVal(target?: string): xdr.ScVal {
  return target
    ? xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('CallContract'),
        new Address(target).toScVal(),
      ])
    : xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')]);
}

/**
 * `MintQuotaParams { max_items: u32, period_ledgers: u32 }`.
 *
 * Precisa ser ScVal pronto: o campo é `Val` no contrato, e o `Spec` não
 * converte objeto simples — o erro que sai é "Received object … did not match
 * the provided type", longe da causa. `scvSortedMap` cuida da ordenação que o
 * host valida.
 */
function mintQuotaParams(maxItems: number, periodLedgers: number): xdr.ScVal {
  return xdr.scvSortedMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('max_items'),
      val: xdr.ScVal.scvU32(maxItems),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('period_ledgers'),
      val: xdr.ScVal.scvU32(periodLedgers),
    }),
  ]);
}

/**
 * Endereço que a conta deste app vai ter — antes de existir.
 *
 * O salt é determinístico (sha256 do app), então reprovisionar o mesmo app
 * aponta para o mesmo endereço em vez de criar uma conta órfã. É também o que
 * permite detectar "já está deployada" sem guardar estado.
 */
export function managedAccountAddress(appId: string, deployerPublicKey: string): string {
  return contractAddressFromPreimage(
    xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: Address.fromString(deployerPublicKey).toScAddress(),
        salt: hash(Buffer.from(`mintvrs:master:${appId}`)),
      }),
    ),
  );
}

async function isDeployed(contractId: string): Promise<boolean> {
  try {
    const entry = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const { entries } = await server.getLedgerEntries(entry);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Faz o deploy da smart account com a chave de owner na regra Default.
 *
 * A taxa é paga pelo channel, como qualquer operação patrocinada — a conta
 * nasce sem precisar de XLM próprio. `createContractV2` não tem credencial
 * `Address` nas auth entries (o deployer é o source da transação), então aqui
 * não há entry para assinar: basta o payer.
 */
export async function deployManagedAccount(options: {
  appId: string;
  payer: Keypair;
}): Promise<{ contractId: string; hash: string | null }> {
  const owner = ownerSignerFor(options.appId);
  const contractId = managedAccountAddress(options.appId, options.payer.publicKey());

  if (await isDeployed(contractId)) {
    logger.info({ appId: options.appId, contractId }, 'conta mestre já deployada');
    return { contractId, hash: null };
  }

  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(options.payer.publicKey()).toScAddress(),
      salt: hash(Buffer.from(`mintvrs:master:${options.appId}`)),
    }),
  );

  const hostFunction = xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: preimage,
      executable: xdr.ContractExecutable.contractExecutableWasm(
        Buffer.from(env.ACCOUNT_WASM_HASH, 'hex'),
      ),
      constructorArgs: [
        // signers: Vec<Signer> — só o owner. O do serviço entra nas regras.
        xdr.ScVal.scvVec([signerScVal(owner)]),
        // policies: Map<Address, Val> — vazio na Default, de propósito. Policy
        // aqui limitaria a própria administração da conta.
        xdr.ScVal.scvMap([]),
      ],
    }),
  );

  const tx = new TransactionBuilder(await server.getAccount(options.payer.publicKey()), {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFunction, auth: [] }))
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(options.payer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`deploy da conta rejeitado: ${JSON.stringify(sent.errorResult)}`);
  }

  const settled = await server.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  if (settled.status !== 'SUCCESS') {
    throw new Error(`deploy da conta não confirmou: status=${settled.status}`);
  }

  logger.info({ appId: options.appId, contractId, hash: sent.hash }, 'conta mestre deployada');
  return { contractId, hash: sent.hash };
}

/**
 * Cria a regra que autoriza a chave do serviço num contrato, com teto.
 *
 * Assinada pelo OWNER sob a regra Default (id 0) — o serviço não consegue se
 * conceder poder, mesmo sendo o mesmo processo, porque a chave que ele usa no
 * dia a dia não está na Default.
 *
 * `valid_until: None` de propósito: o teto é de quantidade, não de prazo. Quem
 * encerra é a revogação.
 */
export async function addServiceRule(options: {
  appId: string;
  masterAccount: string;
  targetContract: string;
  ruleName: string;
  maxItems: number;
  periodLedgers: number;
  payer: Keypair;
}): Promise<{ hash: string }> {
  const service = masterSignerFor(options.appId);

  const result = await invokeAsMaster({
    appId: options.appId,
    masterAccount: options.masterAccount,
    contractId: options.masterAccount,
    fn: 'add_context_rule',
    args: [
      contextTypeScVal(options.targetContract),
      xdr.ScVal.scvString(options.ruleName),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([signerScVal(service)]),
      xdr.scvSortedMap([
        new xdr.ScMapEntry({
          key: new Address(env.MINT_QUOTA_POLICY_ADDRESS).toScVal(),
          val: mintQuotaParams(options.maxItems, options.periodLedgers),
        }),
      ]),
    ],
    contextRuleId: 0,
    payer: options.payer,
    signer: ownerSignerFor(options.appId),
  });

  return { hash: result.hash };
}

/**
 * O id da regra recém-criada.
 *
 * `invokeAsMaster` devolve `{hash, status}` — o valor de retorno do contrato
 * não vem junto. `get_context_rule` por id é a leitura confiável, e o contador
 * é monotônico (conta as removidas), então varremos de trás para frente
 * procurando a regra que aponta para o alvo.
 */
export async function findRuleFor(
  masterAccount: string,
  targetContract: string,
  payer: Keypair,
): Promise<number | null> {
  const count = await readRuleCount(masterAccount, payer);

  for (let id = count; id >= 0; id -= 1) {
    const rule = await readRule(masterAccount, id, payer);
    if (rule === targetContract) return id;
  }
  return null;
}

async function simulate(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  payer: Keypair,
): Promise<xdr.ScVal | null> {
  const tx = new TransactionBuilder(await server.getAccount(payer.publicKey()), {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contractId).toScAddress(),
            functionName: fn,
            args,
          }),
        ),
        auth: [],
      }),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) return null;
  return sim.result?.retval ?? null;
}

async function readRuleCount(masterAccount: string, payer: Keypair): Promise<number> {
  const retval = await simulate(masterAccount, 'get_context_rules_count', [], payer);
  return retval ? Number(retval.u32()) : 0;
}

/** Contrato-alvo de uma regra, ou `null` se ela não é `CallContract`. */
async function readRule(
  masterAccount: string,
  id: number,
  payer: Keypair,
): Promise<string | null> {
  const retval = await simulate(
    masterAccount,
    'get_context_rule',
    [xdr.ScVal.scvU32(id)],
    payer,
  );
  if (!retval) return null;

  for (const field of retval.map() ?? []) {
    if (field.key().sym().toString() !== 'context_type') continue;
    const variant = field.val().vec();
    if (!variant || variant.length < 2) return null;
    if (variant[0]!.sym().toString() !== 'CallContract') return null;
    return Address.fromScAddress(variant[1]!.address()).toString();
  }
  return null;
}

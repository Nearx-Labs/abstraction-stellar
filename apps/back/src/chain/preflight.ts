// Conferência da configuração de rede no boot.
//
// `/health` ecoa o NETWORK_PASSPHRASE do env — não prova nada sobre o RPC. Uma
// instância com RPC de uma rede e passphrase de outra, ou com IDs de contrato
// que não existem nessa rede, subia normalmente e falhava só no primeiro mint.
// Aqui o processo pergunta ao próprio RPC qual é a rede e se cada contrato
// configurado existe nela. Fora de development, divergência derruba o boot.
import { Address, xdr } from '@stellar/stellar-sdk';
import { env, isDev } from '../env.js';
import { logger } from '../logger.js';
import { server } from './rpc.js';

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function codeKey(wasmHashHex: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, 'hex') }),
  );
}

export async function chainPreflight(): Promise<string[]> {
  const problems: string[] = [];

  const network = await server.getNetwork();
  if (network.passphrase !== env.NETWORK_PASSPHRASE) {
    problems.push(
      `o RPC (${env.RPC_URL}) é da rede "${network.passphrase}", mas NETWORK_PASSPHRASE é "${env.NETWORK_PASSPHRASE}"`,
    );
    return problems;
  }

  const contracts: Array<[string, string | undefined]> = [
    ['DEMO_LEDGER_CONTRACT_ID', env.DEMO_LEDGER_CONTRACT_ID],
    ['ANCHOR_CONTRACT_ID', env.ANCHOR_CONTRACT_ID],
    ['MINT_QUOTA_POLICY_ADDRESS', env.MINT_QUOTA_POLICY_ADDRESS],
    ['ED25519_VERIFIER_ADDRESS', env.ED25519_VERIFIER_ADDRESS],
    ['XLM_SAC_ADDRESS', env.XLM_SAC_ADDRESS],
    ['TREASURY_CONTRACT_ID', env.TREASURY_CONTRACT_ID],
  ];

  for (const [name, id] of contracts) {
    if (!id) continue;
    const { entries } = await server.getLedgerEntries(instanceKey(id));
    if (entries.length === 0) problems.push(`${name}=${id} não existe nesta rede`);
  }

  const { entries } = await server.getLedgerEntries(codeKey(env.ACCOUNT_WASM_HASH));
  if (entries.length === 0) {
    problems.push(`ACCOUNT_WASM_HASH=${env.ACCOUNT_WASM_HASH} não foi enviado a esta rede`);
  }

  return problems;
}

/** Roda a conferência; fora de dev, qualquer problema impede o boot. */
export async function assertChainConfig(): Promise<void> {
  let problems: string[];
  try {
    problems = await chainPreflight();
  } catch (error) {
    problems = [`RPC inacessível em ${env.RPC_URL}: ${String(error)}`];
  }

  if (problems.length === 0) {
    logger.info({ network: env.NETWORK_PASSPHRASE }, 'configuração de rede conferida no RPC');
    return;
  }
  if (isDev) {
    logger.warn({ problems }, 'configuração de rede com problemas (ignorado em development)');
    return;
  }
  throw new Error(`Configuração de rede inválida:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
}

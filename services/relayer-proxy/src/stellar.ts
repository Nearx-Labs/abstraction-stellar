// Submissão patrocinada: monta/fee-bumpa transações pagando com a conta do
// sponsor, e debita o consumo on-chain no Treasury (auditabilidade).
import {
  Address,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

export const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
export const RPC_URL = process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org';

export const server = new rpc.Server(RPC_URL);

/** Conta pagadora (sponsor). Em dev, cria e financia uma efêmera. */
export async function loadFeePayer(): Promise<Keypair> {
  if (process.env.FEE_PAYER_SECRET) {
    return Keypair.fromSecret(process.env.FEE_PAYER_SECRET);
  }
  const kp = Keypair.random();
  console.warn(
    `[relayer-proxy] FEE_PAYER_SECRET ausente; criando conta efêmera ${kp.publicKey()} via friendbot (testnet)`,
  );
  const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!res.ok) {
    throw new Error(`friendbot falhou (${res.status}); defina FEE_PAYER_SECRET`);
  }
  return kp;
}

export interface ParsedIntent {
  /** Contratos-alvo invocados. */
  targets: string[];
  /** Smart account autorizante (primeira credencial Address das auth entries). */
  user?: string;
}

export function parseHostFunction(
  hostFn: xdr.HostFunction,
  authEntries: xdr.SorobanAuthorizationEntry[],
): ParsedIntent {
  const targets: string[] = [];
  if (hostFn.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    targets.push(Address.fromScAddress(hostFn.invokeContract().contractAddress()).toString());
  }
  let user: string | undefined;
  for (const entry of authEntries) {
    if (
      entry.credentials().switch() ===
      xdr.SorobanCredentialsType.sorobanCredentialsAddress()
    ) {
      user = Address.fromScAddress(entry.credentials().address().address()).toString();
      break;
    }
  }
  return { targets, user };
}

export function parseTransactionIntent(tx: Transaction): ParsedIntent {
  const targets: string[] = [];
  let user: string | undefined;
  for (const op of tx.operations) {
    if (op.type !== 'invokeHostFunction') continue;
    const parsed = parseHostFunction(op.func, op.auth ?? []);
    targets.push(...parsed.targets);
    user ??= parsed.user;
  }
  return { targets, user };
}

export interface SubmitOutcome {
  hash: string;
  status: string;
  fee: bigint;
}

async function pollUntilSettled(hash: string): Promise<string> {
  const result = await server.pollTransaction(hash, {
    attempts: 30,
    sleepStrategy: () => 1000,
  });
  return result.status;
}

/** Modo Channels: monta a transação a partir de func+auth e paga a fee. */
export async function submitHostFunction(
  payer: Keypair,
  hostFn: xdr.HostFunction,
  authEntries: xdr.SorobanAuthorizationEntry[],
): Promise<{ prepared: Transaction; send: () => Promise<SubmitOutcome> }> {
  const account = await server.getAccount(payer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: authEntries }))
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(tx);
  return {
    prepared,
    send: async () => {
      prepared.sign(payer);
      const res = await server.sendTransaction(prepared);
      if (res.status === 'ERROR') {
        throw new Error(`submissão rejeitada: ${JSON.stringify(res.errorResult)}`);
      }
      const status = await pollUntilSettled(res.hash);
      return { hash: res.hash, status, fee: BigInt(prepared.fee) };
    },
  };
}

/** Modo XDR assinado: envelopa em fee-bump preservando a assinatura interna. */
export async function submitFeeBump(
  payer: Keypair,
  innerXdr: string,
): Promise<{ inner: Transaction; send: () => Promise<SubmitOutcome> }> {
  const inner = TransactionBuilder.fromXDR(innerXdr, NETWORK_PASSPHRASE);
  if (inner instanceof FeeBumpTransaction) {
    throw new Error('a transação já é fee-bump');
  }

  // A base fee do fee-bump precisa cobrir a fee interna (que em Soroban
  // inclui a resource fee) — calcula a partir da própria transação.
  const baseFee = process.env.FEE_BUMP_BASE_FEE ?? (BigInt(inner.fee) + 200n).toString();
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    payer,
    baseFee,
    inner,
    NETWORK_PASSPHRASE,
  );
  return {
    inner,
    send: async () => {
      feeBump.sign(payer);
      const res = await server.sendTransaction(feeBump);
      if (res.status === 'ERROR') {
        throw new Error(`submissão rejeitada: ${JSON.stringify(res.errorResult)}`);
      }
      const status = await pollUntilSettled(res.hash);
      return { hash: res.hash, status, fee: BigInt(feeBump.fee) };
    },
  };
}

/**
 * Débito on-chain best-effort no Treasury (o payer é o operator). Falha aqui
 * não bloqueia a transação do usuário — é trilha de auditoria, não gate.
 */
export async function debitTreasury(
  payer: Keypair,
  treasuryId: string,
  user: string,
  target: string,
  fee: bigint,
): Promise<void> {
  try {
    const account = await server.getAccount(payer.publicKey());
    const contract = new Contract(treasuryId);
    const tx = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'consume',
          new Address(user).toScVal(),
          new Address(target).toScVal(),
          nativeToScVal(fee, { type: 'i128' }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(payer);
    const res = await server.sendTransaction(prepared);
    console.log(`[relayer-proxy] treasury.consume(${user}, ${target}, ${fee}) → ${res.status}`);
  } catch (err) {
    console.error('[relayer-proxy] falha ao debitar treasury (não bloqueante):', err);
  }
}

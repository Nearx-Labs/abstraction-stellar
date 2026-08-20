// Chaves por papel.
//
// O relayer antigo, sem FEE_PAYER_SECRET, gerava `Keypair.random()` e chamava o
// friendbot a cada boot. Além de não persistir nada, isso trocava a identidade
// do fee payer a cada restart — e o fee payer é o `operator` do Treasury, então
// `consume` passava a falhar. Aqui: fora de dev o segredo é obrigatório
// (validado em env.ts); em dev a chave é DETERMINÍSTICA, então sobrevive a
// restarts e o Treasury continua batendo.
import { Keypair, hash } from '@stellar/stellar-sdk';
import { env, isDev } from '../env.js';
import { logger } from '../logger.js';
import { server } from './rpc.js';

export type Role = 'channel' | 'operator' | 'owner' | 'faucet';

function devKey(role: Role, index = 0): Keypair {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(`abstraction-dev:${role}:${index}`)));
}

function fromSecretOr(role: Role, secret: string | undefined, index = 0): Keypair {
  if (secret) return Keypair.fromSecret(secret);
  if (!isDev) {
    // env.ts já barra isso; a checagem aqui é a rede de segurança.
    throw new Error(`chave do papel "${role}" ausente fora de desenvolvimento`);
  }
  const kp = devKey(role, index);
  logger.warn(
    { role, publicKey: kp.publicKey() },
    'usando chave DEV determinística — não use isso fora de desenvolvimento',
  );
  return kp;
}

const channelSecrets = env.CHANNEL_SECRETS;
const DEV_CHANNEL_COUNT = 3;

/** Contas que pagam as transações dos usuários (pool com lease no Postgres). */
export const channels: Keypair[] =
  channelSecrets.length > 0
    ? channelSecrets.map((s) => Keypair.fromSecret(s))
    : isDev
      ? Array.from({ length: DEV_CHANNEL_COUNT }, (_, i) => fromSecretOr('channel', undefined, i))
      : [];

/** Assina `Treasury.consume` (o contrato guarda um operator só). */
export const operator = fromSecretOr('operator', env.TREASURY_OPERATOR_SECRET);

/** Assina `set_allowance` / `allow_target` — ambos `#[only_owner]`. */
export const owner = fromSecretOr('owner', env.TREASURY_OWNER_SECRET);

/** Envia XLM de testnet para as smart accounts. */
export const faucet = fromSecretOr('faucet', env.FAUCET_SECRET);

export const allKeys: Array<{ role: Role; keypair: Keypair }> = [
  ...channels.map((keypair) => ({ role: 'channel' as const, keypair })),
  { role: 'operator', keypair: operator },
  { role: 'owner', keypair: owner },
  { role: 'faucet', keypair: faucet },
];

const bySecret = new Map(allKeys.map(({ keypair }) => [keypair.publicKey(), keypair]));

/** Recupera o Keypair de uma linha de `fee_payer_channels` (que só guarda a pública). */
export function keypairFor(publicKey: string): Keypair {
  const kp = bySecret.get(publicKey);
  if (!kp) throw new Error(`sem segredo para ${publicKey}; confira CHANNEL_SECRETS`);
  return kp;
}

/**
 * Em dev, financia via friendbot qualquer conta de papel que ainda não exista.
 * Idempotente: conta que já existe é ignorada.
 */
export async function ensureFundedInDev(): Promise<void> {
  if (!isDev) return;
  await Promise.all(
    allKeys.map(async ({ role, keypair }) => {
      try {
        await server.getAccount(keypair.publicKey());
      } catch {
        logger.info({ role, publicKey: keypair.publicKey() }, 'financiando conta dev no friendbot');
        const res = await fetch(`${env.FRIENDBOT_URL}?addr=${keypair.publicKey()}`);
        if (!res.ok) {
          logger.error(
            { role, status: res.status },
            'friendbot falhou; a conta pode não existir ainda',
          );
        }
      }
    }),
  );
}

// Seed de desenvolvimento: um app pronto para usar assim que o compose sobe.
//
// As chaves são fixas de propósito — em dev o valor é poder colar
// `relayerUrl: http://localhost:8080/v1/relay/pk_test_dev` no front e seguir.
// Fora de desenvolvimento isto não roda.
import { pool } from './pool.js';
import { hashKey } from './queries/apps.js';
import { env, isDev } from '../env.js';
import { logger } from '../logger.js';

export const DEV_PUBLISHABLE_KEY = 'pk_test_dev';
export const DEV_SECRET_KEY = 'sk_test_dev';
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'];

export async function seedDev(): Promise<void> {
  if (!isDev) return;

  const treasuryId = env.TREASURY_CONTRACT_ID ?? '';
  const app = await pool.query<{ id: string }>(
    `INSERT INTO apps (slug, name, network, treasury_id)
     VALUES ('demo', 'Abstraction Demo', 'testnet', $1)
     ON CONFLICT (slug) DO UPDATE SET treasury_id = EXCLUDED.treasury_id
     RETURNING id`,
    [treasuryId],
  );
  const appId = app.rows[0]!.id;

  for (const [key, kind] of [
    [DEV_PUBLISHABLE_KEY, 'publishable'],
    [DEV_SECRET_KEY, 'secret'],
  ] as const) {
    await pool.query(
      `INSERT INTO api_keys (app_id, kind, key_prefix, key_hash, label)
       VALUES ($1, $2, $3, $4, 'dev')
       ON CONFLICT (key_hash) DO NOTHING`,
      [appId, kind, key.slice(0, 12), hashKey(key)],
    );
  }

  for (const origin of DEV_ORIGINS) {
    await pool.query(
      `INSERT INTO app_origins (app_id, origin) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [appId, origin],
    );
  }

  await pool.query(
    `INSERT INTO sponsorship_policies
       (app_id, max_fee_per_tx, max_fee_per_day, target_allowlist, allow_deploy, deploy_fee_cap)
     VALUES ($1, $2, $3, $4, true, $5)
     ON CONFLICT (app_id) DO UPDATE
        SET target_allowlist = EXCLUDED.target_allowlist,
            max_fee_per_tx   = EXCLUDED.max_fee_per_tx,
            max_fee_per_day  = EXCLUDED.max_fee_per_day,
            deploy_fee_cap   = EXCLUDED.deploy_fee_cap,
            updated_at       = now()`,
    [
      appId,
      // Uma criação de context rule (policy + assinatura WebAuthn) custa
      // ~1,02 XLM no testnet; abaixo disso o produto não funciona.
      env.ALLOWANCE_MAX_PER_TX.toString(),
      env.ALLOWANCE_MAX_PER_DAY.toString(),
      [env.XLM_SAC_ADDRESS, env.DEMO_LEDGER_CONTRACT_ID],
      '50000000', // 5 XLM de teto para o deploy
    ],
  );

  logger.info(
    { appId, publishableKey: DEV_PUBLISHABLE_KEY },
    'app de desenvolvimento pronto',
  );
}

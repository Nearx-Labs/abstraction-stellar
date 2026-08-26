// Provisiona um app — um tenant do sistema consumidor.
//
//   npm run app:create -- --slug mintvrs-acme --name "Acme" --origin https://acme.mintvrs.com
//
// Até aqui só existia o `seedDev()`, que é `if (!isDev) return` e cria o app
// `demo` com chaves fixas. Isso serve para colar `pk_test_dev` no front e
// seguir; não serve para um tenant real, que precisa de chaves próprias e de
// cota isolada.
//
// As chaves são impressas UMA vez. O banco guarda só o sha256 — não há como
// recuperá-las depois, só revogar e emitir outras. É de propósito: uma secret
// key legível no Postgres é uma secret key vazada no dia do dump.
import { randomBytes } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { hashKey } from '../src/db/queries/apps.js';
import { env } from '../src/env.js';
import { migrate } from '../src/db/migrate.js';

interface Options {
  slug: string;
  name: string;
  origins: string[];
  maxFeePerTx: bigint;
  maxFeePerDay: bigint;
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\n` +
      'uso: npm run app:create -- --slug <slug> [--name <nome>] [--origin <url>]...\n' +
      '     --origin pode repetir; entra no CORS do painel deste tenant.\n',
  );
  process.exit(1);
}

function parse(argv: string[]): Options {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`--${key} precisa de valor`);
    values.set(key, [...(values.get(key) ?? []), value]);
    i += 1;
  }

  const slug = values.get('slug')?.[0];
  if (!slug) usage('--slug é obrigatório');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    usage('--slug aceita [a-z0-9-], começando por letra ou número');
  }

  return {
    slug,
    name: values.get('name')?.[0] ?? slug,
    origins: values.get('origin') ?? [],
    maxFeePerTx: BigInt(values.get('max-fee-per-tx')?.[0] ?? env.ALLOWANCE_MAX_PER_TX),
    maxFeePerDay: BigInt(values.get('max-fee-per-day')?.[0] ?? env.ALLOWANCE_MAX_PER_DAY),
  };
}

/** `pk_live_…` / `sk_live_…`, 32 bytes de entropia em base64url. */
function mintKey(kind: 'pk' | 'sk'): string {
  const scope = env.NODE_ENV === 'production' ? 'live' : 'test';
  return `${kind}_${scope}_${randomBytes(24).toString('base64url')}`;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));

  if (!env.TREASURY_CONTRACT_ID) {
    process.stderr.write(
      'TREASURY_CONTRACT_ID não configurado — sem ele o app nasce sem paymaster.\n',
    );
    process.exit(1);
  }

  // Um app criado contra um banco não migrado nasce sem `master_account`.
  await migrate();

  const publishableKey = mintKey('pk');
  const secretKey = mintKey('sk');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ id: string }>('SELECT id FROM apps WHERE slug = $1', [
      options.slug,
    ]);
    if (existing.rows.length > 0) {
      // Não sobrescreve: reemitir chave de um app vivo é operação de revogação,
      // não de criação, e fazer as duas no mesmo comando convida ao acidente.
      throw new Error(
        `o app "${options.slug}" já existe (${existing.rows[0]!.id}). ` +
          'Para trocar as chaves, revogue as atuais em api_keys e emita novas.',
      );
    }

    const app = await client.query<{ id: string }>(
      `INSERT INTO apps (slug, name, network, treasury_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [options.slug, options.name, env.NETWORK_PASSPHRASE.includes('Public') ? 'pubnet' : 'testnet', env.TREASURY_CONTRACT_ID],
    );
    const appId = app.rows[0]!.id;

    for (const [key, kind] of [
      [publishableKey, 'publishable'],
      [secretKey, 'secret'],
    ] as const) {
      await client.query(
        `INSERT INTO api_keys (app_id, kind, key_prefix, key_hash, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [appId, kind, key.slice(0, 12), hashKey(key), 'created by app:create'],
      );
    }

    for (const origin of options.origins) {
      await client.query(
        'INSERT INTO app_origins (app_id, origin) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [appId, origin],
      );
    }

    await client.query(
      `INSERT INTO sponsorship_policies
         (app_id, max_fee_per_tx, max_fee_per_day, target_allowlist, allow_deploy, deploy_fee_cap)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [
        appId,
        options.maxFeePerTx.toString(),
        options.maxFeePerDay.toString(),
        // Os dois alvos que a conta mestre assina, mais o SAC do XLM que o
        // faucet usa. Allowlist vazia é recusa, não "patrocina tudo".
        [env.XLM_SAC_ADDRESS, env.DEMO_LEDGER_CONTRACT_ID, env.ANCHOR_CONTRACT_ID],
        '50000000',
      ],
    );

    await client.query('COMMIT');

    process.stdout.write(
      [
        '',
        `app criado: ${options.name} (${options.slug})`,
        `  id              ${appId}`,
        `  publishableKey  ${publishableKey}`,
        `  secretKey       ${secretKey}`,
        '',
        'Guarde a secret key agora — o banco tem só o hash dela.',
        '',
        'Falta o passo com passkey, que o serviço não pode fazer por si:',
        `  1. abra o painel, registre a conta com passkey e use o faucet`,
        `  2. POST /v1/master            → define a conta mestre`,
        `  3. POST /v1/master/grant      → target "ledger", com o nº de itens do inventário`,
        `  4. POST /v1/master/grant      → target "anchor", com o teto de eventos ancorados`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });

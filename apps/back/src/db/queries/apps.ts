// Resolução de app a partir de API key, e a policy de patrocínio.
//
// A policy saiu do env (loadPolicy em services/relayer-proxy/src/policy.ts) e
// virou linha de tabela, por app. A diferença de comportamento que importa:
// allowlist vazia era "patrocina QUALQUER contrato" com um console.warn; agora
// é recusa.
import { createHash } from 'node:crypto';
import { pool } from '../pool.js';

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  network: string;
  treasuryId: string;
}

export interface SponsorshipPolicy {
  maxFeePerTx: bigint;
  maxFeePerDay: bigint;
  maxFeePerDayApp?: bigint;
  targetAllowlist: Set<string>;
  allowDeploy: boolean;
  deployFeeCap: bigint;
}

export interface ResolvedApp {
  app: AppRecord;
  policy: SponsorshipPolicy;
}

export function hashKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

type Row = {
  id: string;
  slug: string;
  name: string;
  network: string;
  treasury_id: string;
  max_fee_per_tx: bigint;
  max_fee_per_day: bigint;
  max_fee_per_day_app: bigint | null;
  target_allowlist: string[];
  allow_deploy: boolean;
  deploy_fee_cap: bigint;
};

function toResolved(row: Row): ResolvedApp {
  return {
    app: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      network: row.network,
      treasuryId: row.treasury_id,
    },
    policy: {
      maxFeePerTx: BigInt(row.max_fee_per_tx),
      maxFeePerDay: BigInt(row.max_fee_per_day),
      maxFeePerDayApp:
        row.max_fee_per_day_app === null ? undefined : BigInt(row.max_fee_per_day_app),
      targetAllowlist: new Set(row.target_allowlist),
      allowDeploy: row.allow_deploy,
      deployFeeCap: BigInt(row.deploy_fee_cap),
    },
  };
}

const SELECT = `
  SELECT a.id, a.slug, a.name, a.network, a.treasury_id,
         p.max_fee_per_tx, p.max_fee_per_day, p.max_fee_per_day_app,
         p.target_allowlist, p.allow_deploy, p.deploy_fee_cap
    FROM apps a
    JOIN sponsorship_policies p ON p.app_id = a.id
`;

/** Resolve por API key (publishable no path do relay, ou secret no Bearer). */
export async function resolveByKey(
  key: string,
  kind: 'publishable' | 'secret',
): Promise<ResolvedApp | null> {
  const res = await pool.query<Row>(
    `${SELECT}
      JOIN api_keys k ON k.app_id = a.id
     WHERE k.key_hash = $1 AND k.kind = $2
       AND k.revoked_at IS NULL AND a.disabled_at IS NULL`,
    [hashKey(key), kind],
  );
  const row = res.rows[0];
  if (!row) return null;

  // last_used_at é observabilidade, não caminho crítico.
  void pool
    .query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1', [hashKey(key)])
    .catch(() => {});

  return toResolved(row);
}

export async function resolveBySlug(slug: string): Promise<ResolvedApp | null> {
  const res = await pool.query<Row>(`${SELECT} WHERE a.slug = $1`, [slug]);
  const row = res.rows[0];
  return row ? toResolved(row) : null;
}

/** Origens permitidas de um app — alimenta o CORS. */
export async function originsFor(appId: string): Promise<string[]> {
  const res = await pool.query<{ origin: string }>(
    'SELECT origin FROM app_origins WHERE app_id = $1',
    [appId],
  );
  return res.rows.map((r) => r.origin);
}

/** Todas as origens registradas (cacheado no middleware de CORS). */
export async function allOrigins(): Promise<string[]> {
  const res = await pool.query<{ origin: string }>('SELECT DISTINCT origin FROM app_origins');
  return res.rows.map((r) => r.origin);
}

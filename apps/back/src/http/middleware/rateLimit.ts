// Rate limit por janela fixa, no Postgres.
//
// Fica no banco (e não em memória) pelo mesmo motivo da quota: com N réplicas,
// um contador local multiplica o limite por N.
import type { Context, MiddlewareHandler } from 'hono';
import { pool } from '../../db/pool.js';

export interface RateLimitOptions {
  /** Prefixo do bucket, ex.: 'relay' ou 'faucet'. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Chave adicional além do IP (ex.: a smart account). */
  keyOf?: (c: Context) => string | undefined;
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? '0.0.0.0';
}

/** Retorna true se a requisição passou (não estourou o limite). */
export async function hit(
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const res = await pool.query<{ count: number }>(
    `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, expires_at)
     VALUES ($1, 1, now(), now() + ($2 || ' seconds')::interval)
     ON CONFLICT (bucket_key) DO UPDATE
        SET count = CASE
              WHEN rate_limit_buckets.expires_at < now() THEN 1
              ELSE rate_limit_buckets.count + 1 END,
            window_start = CASE
              WHEN rate_limit_buckets.expires_at < now() THEN now()
              ELSE rate_limit_buckets.window_start END,
            expires_at = CASE
              WHEN rate_limit_buckets.expires_at < now()
              THEN now() + ($2 || ' seconds')::interval
              ELSE rate_limit_buckets.expires_at END
     RETURNING count`,
    [bucketKey, windowSeconds],
  );
  return (res.rows[0]?.count ?? 1) <= limit;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const extra = options.keyOf?.(c);
    const bucket = `${options.name}:${clientIp(c)}${extra ? `:${extra}` : ''}`;
    if (!(await hit(bucket, options.limit, options.windowSeconds))) {
      return c.json(
        { success: false, error: 'muitas requisições; aguarde', errorCode: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(options.windowSeconds) },
      );
    }
    await next();
  };
}

/** Poda buckets e outros registros efêmeros vencidos. */
export async function gcExpired(): Promise<void> {
  await pool.query('DELETE FROM rate_limit_buckets WHERE expires_at < now()');
  await pool.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
  await pool.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  await pool.query('DELETE FROM email_otps WHERE expires_at < now()');
  await pool.query('DELETE FROM email_sessions WHERE expires_at < now()');
}

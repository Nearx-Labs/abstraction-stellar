// Estado do emissor de attestations de email.
//
// Sai dos `Map` de services/auth-issuer/src/index.ts:40-41, que zeravam a cada
// restart e não eram compartilhados entre réplicas. Dois endurecimentos de
// passagem: o código do OTP é guardado hasheado (não em claro), e o par
// (subject, challenge) só pode ser assinado uma vez.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../pool.js';

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();

export async function putOtp(
  emailNorm: string,
  code: string,
  ttlMinutes: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO email_otps (email_norm, code_hash, attempts, expires_at)
     VALUES ($1, $2, 0, now() + ($3 || ' minutes')::interval)
     ON CONFLICT (email_norm) DO UPDATE
        SET code_hash = EXCLUDED.code_hash, attempts = 0,
            expires_at = EXCLUDED.expires_at, created_at = now()`,
    [emailNorm, sha256(code), ttlMinutes],
  );
}

export type OtpResult = 'ok' | 'missing' | 'expired' | 'too_many' | 'wrong';

export async function consumeOtp(emailNorm: string, code: string): Promise<OtpResult> {
  const res = await pool.query<{ code_hash: Buffer; attempts: number; expired: boolean }>(
    `UPDATE email_otps
        SET attempts = attempts + 1
      WHERE email_norm = $1
      RETURNING code_hash, attempts, (expires_at < now()) AS expired`,
    [emailNorm],
  );
  const row = res.rows[0];
  if (!row) return 'missing';
  if (row.expired) {
    await pool.query('DELETE FROM email_otps WHERE email_norm = $1', [emailNorm]);
    return 'expired';
  }
  if (row.attempts > 5) {
    await pool.query('DELETE FROM email_otps WHERE email_norm = $1', [emailNorm]);
    return 'too_many';
  }

  const expected = row.code_hash;
  const got = sha256(code);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return 'wrong';

  await pool.query('DELETE FROM email_otps WHERE email_norm = $1', [emailNorm]);
  return 'ok';
}

export async function createSession(
  emailNorm: string,
  subject: Buffer,
  ttlMinutes: number,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO email_sessions (token_hash, email_norm, subject_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [sha256(token), emailNorm, subject, ttlMinutes],
  );
  return token;
}

export async function sessionFor(
  token: string,
): Promise<{ emailNorm: string; subjectHash: Buffer } | null> {
  const res = await pool.query<{ email_norm: string; subject_hash: Buffer }>(
    `SELECT email_norm, subject_hash FROM email_sessions
      WHERE token_hash = $1 AND expires_at > now()`,
    [sha256(token)],
  );
  const row = res.rows[0];
  return row ? { emailNorm: row.email_norm, subjectHash: row.subject_hash } : null;
}

/**
 * Registra a emissão. Retorna false se este (subject, challenge) já foi
 * assinado — o challenge é o auth digest exato de uma transação, então
 * reemitir para o mesmo par só serviria para reaproveitar assinatura.
 */
export async function recordAttestation(
  subject: Buffer,
  challenge: Buffer,
  expiresAt: bigint,
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO attestations_issued (subject_hash, challenge, expires_at)
     VALUES ($1, $2, to_timestamp($3))
     ON CONFLICT (subject_hash, challenge) DO NOTHING
     RETURNING id`,
    [subject, challenge, Number(expiresAt)],
  );
  return res.rows.length > 0;
}

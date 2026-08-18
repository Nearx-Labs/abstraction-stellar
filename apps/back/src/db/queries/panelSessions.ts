// Sessão do painel: challenge de WebAuthn + cookie de sessão.
//
// A publishable key não serve para autorizar faucet ou allowance — ela é
// pública. Aqui o dono da conta prova posse da passkey e recebe um cookie
// httpOnly de curta duração.
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../pool.js';

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();

const CHALLENGE_TTL_SECONDS = 300;

export async function createChallenge(contractId: string): Promise<Buffer> {
  const nonce = randomBytes(32);
  await pool.query(
    `INSERT INTO webauthn_challenges (nonce, contract_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [nonce, contractId, CHALLENGE_TTL_SECONDS],
  );
  return nonce;
}

/** Consome o challenge — de uso único, mesmo em corrida. */
export async function consumeChallenge(nonce: Buffer): Promise<{ contractId: string } | null> {
  const res = await pool.query<{ contract_id: string }>(
    `UPDATE webauthn_challenges
        SET consumed_at = now()
      WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING contract_id`,
    [nonce],
  );
  const row = res.rows[0];
  return row ? { contractId: row.contract_id } : null;
}

export async function createSession(
  accountId: string,
  ttlHours: number,
  ip?: string,
  userAgent?: string,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO account_sessions (account_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)`,
    [accountId, sha256(token), ip ?? null, userAgent ?? null, ttlHours],
  );
  return token;
}

export interface PanelSession {
  accountId: string;
  appId: string;
  contractId: string;
}

export async function resolveSession(token: string): Promise<PanelSession | null> {
  const res = await pool.query<{ account_id: string; app_id: string; contract_id: string }>(
    `SELECT s.account_id, a.app_id, a.contract_id
       FROM account_sessions s
       JOIN smart_accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = res.rows[0];
  return row
    ? { accountId: row.account_id, appId: row.app_id, contractId: row.contract_id }
    : null;
}

export async function revokeSession(token: string): Promise<void> {
  await pool.query(
    'UPDATE account_sessions SET revoked_at = now() WHERE token_hash = $1',
    [sha256(token)],
  );
}

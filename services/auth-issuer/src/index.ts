// Auth Issuer — serviço off-chain da Fase 2.
//
// Fluxo: o usuário prova posse do email (OTP; em dev o código sai no
// console), recebe uma sessão curta e então pode pedir attestations com TTL
// de minutos, vinculadas ao auth digest exato da transação (challenge).
// O contrato email-attestation-verifier verifica a assinatura deste emissor.
//
// AVISO dev-only: store em memória, OTP no console, chave default
// determinística. Em produção: KMS/HSM para a chave, envio real de email,
// store persistente, rate limiting e observabilidade.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { buildAttestationXdr, keyDataFor, subjectHash } from './attestation.js';

const PORT = Number(process.env.PORT ?? 8788);
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const ATTESTATION_TTL_SECS = 5n * 60n;
const SUBJECT_SALT = process.env.SUBJECT_SALT ?? 'abstraction-dev-salt';

const issuer = process.env.ISSUER_SEED_HEX
  ? Keypair.fromRawEd25519Seed(Buffer.from(process.env.ISSUER_SEED_HEX, 'hex'))
  : Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
if (!process.env.ISSUER_SEED_HEX) {
  console.warn('[auth-issuer] usando chave DEV determinística; defina ISSUER_SEED_HEX em produção');
}

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}
interface Session {
  email: string;
  expiresAt: number;
}

const otps = new Map<string, OtpEntry>();
const sessions = new Map<string, Session>();

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, issuerPublicKey: issuer.rawPublicKey().toString('hex') }),
);

app.post('/auth/request', async (c) => {
  const { email } = await c.req.json<{ email?: string }>();
  if (!email || !email.includes('@')) {
    return c.json({ error: 'email inválido' }, 400);
  }
  const normalized = email.trim().toLowerCase();
  const code = randomBytes(3).readUIntBE(0, 3).toString().padStart(6, '0').slice(0, 6);
  otps.set(normalized, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  // Dev: em produção, enviar por email de verdade.
  console.log(`[auth-issuer] OTP para ${normalized}: ${code}`);
  return c.json({ ok: true });
});

app.post('/auth/verify', async (c) => {
  const { email, code } = await c.req.json<{ email?: string; code?: string }>();
  if (!email || !code) return c.json({ error: 'email e code são obrigatórios' }, 400);

  const normalized = email.trim().toLowerCase();
  const entry = otps.get(normalized);
  if (!entry || Date.now() > entry.expiresAt) {
    return c.json({ error: 'OTP expirado ou inexistente' }, 401);
  }
  entry.attempts += 1;
  if (entry.attempts > 5) {
    otps.delete(normalized);
    return c.json({ error: 'muitas tentativas' }, 429);
  }
  const expected = Buffer.from(entry.code);
  const got = Buffer.from(code);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return c.json({ error: 'código incorreto' }, 401);
  }
  otps.delete(normalized);

  const token = randomBytes(32).toString('hex');
  sessions.set(token, { email: normalized, expiresAt: Date.now() + SESSION_TTL_MS });

  const subject = subjectHash(normalized, SUBJECT_SALT);
  return c.json({
    token,
    // O cliente registra este key_data como Signer::External(verifier, keyData)
    // numa context rule CallContract da smart account.
    subjectHash: subject.toString('hex'),
    keyData: keyDataFor(issuer, subject).toString('hex'),
  });
});

app.post('/attest', async (c) => {
  const { token, challenge } = await c.req.json<{ token?: string; challenge?: string }>();
  if (!token || !challenge) return c.json({ error: 'token e challenge são obrigatórios' }, 400);

  const session = sessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    return c.json({ error: 'sessão expirada' }, 401);
  }
  const challengeBuf = Buffer.from(challenge, 'hex');
  if (challengeBuf.length !== 32) {
    return c.json({ error: 'challenge deve ser o auth digest de 32 bytes em hex' }, 400);
  }

  const subject = subjectHash(session.email, SUBJECT_SALT);
  const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + ATTESTATION_TTL_SECS;
  const sigData = buildAttestationXdr(issuer, subject, challengeBuf, expiresAt);

  return c.json({
    sigDataXdr: sigData.toString('base64'),
    expiresAt: expiresAt.toString(),
  });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[auth-issuer] ouvindo em http://localhost:${PORT}`);
});

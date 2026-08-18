// Emissor de attestations de email (Fase 2).
//
// Mesma semântica do services/auth-issuer, com o estado no Postgres e rate
// limit. Não tem UI neste momento — a garantia de que continua funcionando é o
// teste de integração em test/email-flow.test.ts, que roda OTP → sessão →
// attestation e confere o resultado contra o vetor consumido pelo teste Rust.
//
// A chave do emissor deixou de ter default: sem ISSUER_SEED_HEX fora de
// desenvolvimento o processo não sobe (env.ts). Antes o default era
// Buffer.alloc(32, 42) — a mesma chave publicada no fixture de teste, o que
// permitiria a qualquer um forjar attestation de qualquer email.
import { Hono } from 'hono';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { env, isDev } from '../env.js';
import { logger } from '../logger.js';
import { buildAttestationXdr, keyDataFor, subjectHash } from '../email/attestation.js';
import * as store from '../db/queries/email.js';
import { rateLimit } from './middleware/rateLimit.js';

const issuer = env.ISSUER_SEED_HEX
  ? Keypair.fromRawEd25519Seed(Buffer.from(env.ISSUER_SEED_HEX, 'hex'))
  : Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));

if (!env.ISSUER_SEED_HEX && isDev) {
  logger.warn('ISSUER_SEED_HEX ausente: usando a chave DEV do fixture, só em desenvolvimento');
}

export const emailRoutes = new Hono();

emailRoutes.get('/email/issuer', (c) =>
  c.json({ issuerPublicKey: issuer.rawPublicKey().toString('hex') }),
);

emailRoutes.post(
  '/email/request',
  rateLimit({ name: 'email-request', limit: 5, windowSeconds: 300 }),
  async (c) => {
    const { email } = await c.req.json<{ email?: string }>();
    if (!email || !email.includes('@')) {
      return c.json({ error: 'email inválido', errorCode: 'INVALID_PARAMS' }, 400);
    }
    const normalized = email.trim().toLowerCase();
    const code = randomBytes(3).readUIntBE(0, 3).toString().padStart(6, '0').slice(0, 6);
    await store.putOtp(normalized, code, env.OTP_TTL_MINUTES);

    // TODO(produção): enviar por email de verdade. Em dev sai no log.
    if (isDev) logger.info({ email: normalized, code }, 'OTP de desenvolvimento');
    return c.json({ ok: true });
  },
);

emailRoutes.post(
  '/email/verify',
  rateLimit({ name: 'email-verify', limit: 10, windowSeconds: 300 }),
  async (c) => {
    const { email, code } = await c.req.json<{ email?: string; code?: string }>();
    if (!email || !code) {
      return c.json({ error: 'email e code são obrigatórios', errorCode: 'INVALID_PARAMS' }, 400);
    }
    const normalized = email.trim().toLowerCase();

    const result = await store.consumeOtp(normalized, code);
    if (result !== 'ok') {
      const status = result === 'too_many' ? 429 : 401;
      const messages: Record<string, string> = {
        missing: 'OTP inexistente',
        expired: 'OTP expirado',
        too_many: 'muitas tentativas',
        wrong: 'código incorreto',
      };
      return c.json({ error: messages[result], errorCode: 'UNAUTHORIZED' }, status);
    }

    const subject = subjectHash(normalized, env.SUBJECT_SALT);
    const token = await store.createSession(normalized, subject, env.EMAIL_SESSION_TTL_MINUTES);

    return c.json({
      token,
      subjectHash: subject.toString('hex'),
      // Registrado como Signer::External(verifier, keyData) numa context rule
      // CallContract da smart account — nunca na regra Default.
      keyData: keyDataFor(issuer, subject).toString('hex'),
    });
  },
);

emailRoutes.post(
  '/email/attest',
  rateLimit({ name: 'email-attest', limit: 30, windowSeconds: 60 }),
  async (c) => {
    const { token, challenge } = await c.req.json<{ token?: string; challenge?: string }>();
    if (!token || !challenge) {
      return c.json(
        { error: 'token e challenge são obrigatórios', errorCode: 'INVALID_PARAMS' },
        400,
      );
    }

    const session = await store.sessionFor(token);
    if (!session) return c.json({ error: 'sessão expirada', errorCode: 'UNAUTHORIZED' }, 401);

    const challengeBuf = Buffer.from(challenge, 'hex');
    if (challengeBuf.length !== 32) {
      return c.json(
        {
          error: 'challenge deve ser o auth digest de 32 bytes em hex',
          errorCode: 'INVALID_PARAMS',
        },
        400,
      );
    }

    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(env.ATTESTATION_TTL_SECONDS);
    const fresh = await store.recordAttestation(session.subjectHash, challengeBuf, expiresAt);
    if (!fresh) {
      return c.json(
        { error: 'este challenge já foi assinado', errorCode: 'ALREADY_ISSUED' },
        409,
      );
    }

    const sigData = buildAttestationXdr(issuer, session.subjectHash, challengeBuf, expiresAt);
    return c.json({ sigDataXdr: sigData.toString('base64'), expiresAt: expiresAt.toString() });
  },
);

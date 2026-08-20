// A Fase 2 não tem UI, então a garantia de que ela continua funcionando é
// este teste, não código morto no front.
//
// Duas coisas são verificadas:
//
//  1. O fluxo OTP → sessão → attestation, agora com estado no Postgres em vez
//     dos Maps de processo, incluindo o bloqueio de reemissão do mesmo
//     (subject, challenge).
//
//  2. Que o encoding da attestation não mudou. O arquivo
//     contracts/email-attestation-verifier/fixtures/js_attestation_vector.txt
//     é lido por include_str! no teste Rust `verify_js_generated_attestation`
//     — se este módulo divergir dele, o contrato passa a rejeitar as
//     attestations que o serviço emite, e só o teste Rust perceberia.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildAttestationXdr, keyDataFor, subjectHash } = await import(
  '../src/email/attestation.js'
);
const store = await import('../src/db/queries/email.js');

const EMAIL = 'teste@abstraction.dev';
const SALT = 'abstraction-dev-salt';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.query('DELETE FROM email_otps WHERE email_norm = $1', [EMAIL]);
  await pool.query('DELETE FROM email_sessions WHERE email_norm = $1', [EMAIL]);
  await pool.query('DELETE FROM attestations_issued WHERE subject_hash = $1', [
    subjectHash(EMAIL, SALT),
  ]);
  await pool.end();
});

describe('fluxo de attestation por email', () => {
  it('emite attestation depois do OTP e barra reemissão do mesmo challenge', async () => {
    await store.putOtp(EMAIL, '123456', 10);

    expect(await store.consumeOtp(EMAIL, '000000')).toBe('wrong');
    expect(await store.consumeOtp(EMAIL, '123456')).toBe('ok');
    // Consumido: o mesmo código não vale de novo.
    expect(await store.consumeOtp(EMAIL, '123456')).toBe('missing');

    const subject = subjectHash(EMAIL, SALT);
    const token = await store.createSession(EMAIL, subject, 15);
    const session = await store.sessionFor(token);
    expect(session?.emailNorm).toBe(EMAIL);

    const challenge = Buffer.alloc(32, 7);
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + 300n;

    expect(await store.recordAttestation(subject, challenge, expiresAt)).toBe(true);
    // Endurecimento novo: o mesmo par (subject, challenge) só é assinado uma vez.
    expect(await store.recordAttestation(subject, challenge, expiresAt)).toBe(false);

    const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
    const sigData = buildAttestationXdr(issuer, subject, challenge, expiresAt);
    expect(sigData.length).toBeGreaterThan(64);
  });

  it('sessão inexistente não resolve', async () => {
    expect(await store.sessionFor('token-que-nao-existe')).toBeNull();
  });
});

describe('vetor cross-language', () => {
  it('bate com o arquivo consumido pelo teste Rust do verificador', async () => {
    // Mesmos valores de src/email/fixture.ts e dos testes Rust.
    const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
    const subject = Buffer.alloc(32, 1);
    const challenge = Buffer.alloc(32, 2);
    const expiresAt = 1_800_000_300n;

    const generated = [
      `key_data=${keyDataFor(issuer, subject).toString('hex')}`,
      `sig_data=${buildAttestationXdr(issuer, subject, challenge, expiresAt).toString('hex')}`,
      `payload=${challenge.toString('hex')}`,
      `timestamp=${(expiresAt - 300n).toString()}`,
      '',
    ].join('\n');

    const committed = await readFile(
      fileURLToPath(
        new URL(
          '../../../contracts/email-attestation-verifier/fixtures/js_attestation_vector.txt',
          import.meta.url,
        ),
      ),
      'utf8',
    );

    expect(generated).toBe(committed);
  });
});

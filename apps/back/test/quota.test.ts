// A propriedade que este teste protege: sob concorrência, e com mais de uma
// réplica, a soma reservada + liquidada NUNCA passa do teto diário.
//
// O relayer antigo guardava isso num Map de processo — dois pods davam duas
// quotas, e um `SELECT` seguido de `UPDATE` teria janela de corrida mesmo com
// um pod só.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgres://abstraction:abstraction@localhost:5434/abstraction';

const { pool, tx } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const quota = await import('../src/db/queries/quota.js');

const APP_SLUG = 'test-quota';
let appId: string;

beforeAll(async () => {
  await migrate();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO apps (slug, name, treasury_id) VALUES ($1, 'test', 'C')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [APP_SLUG],
  );
  appId = res.rows[0]!.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM fee_quota_daily WHERE app_id = $1', [appId]);
  await pool.query('DELETE FROM apps WHERE slug = $1', [APP_SLUG]);
  await pool.end();
});

async function freshAccount(): Promise<string> {
  const account = `C${Math.random().toString(36).slice(2).toUpperCase().padEnd(55, 'A').slice(0, 55)}`;
  await pool.query('DELETE FROM fee_quota_daily WHERE app_id = $1 AND smart_account = $2', [
    appId,
    account,
  ]);
  return account;
}

describe('reserva de quota', () => {
  it('deixa passar exatamente o que cabe no teto, sob concorrência', async () => {
    const account = await freshAccount();
    const perTx = 100n;
    const maxPerDay = 1000n; // cabem exatamente 10
    const attempts = 25;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        tx((client) => quota.reserve(client, appId, account, perTx, maxPerDay)),
      ),
    );

    const accepted = results.filter((r) => r !== null).length;
    expect(accepted).toBe(10);

    const snap = await quota.snapshot(appId, account);
    expect(snap.reserved).toBe(1000n);
    expect(snap.reserved + snap.settled).toBeLessThanOrEqual(maxPerDay);
  });

  it('recusa quando o teto já foi consumido', async () => {
    const account = await freshAccount();
    const ok = await tx((c) => quota.reserve(c, appId, account, 500n, 500n));
    expect(ok).not.toBeNull();

    const denied = await tx((c) => quota.reserve(c, appId, account, 1n, 500n));
    expect(denied).toBeNull();
  });

  it('liquida pelo custo real e devolve a diferença do teto', async () => {
    const account = await freshAccount();
    const day = (await pool.query<{ d: string }>(`SELECT ${quota.DAY_SQL}::text AS d`)).rows[0]!.d;

    // Reserva um teto de 1000 e a rede cobra 137.
    await tx((c) => quota.reserve(c, appId, account, 1000n, 5000n));
    await tx((c) => quota.settle(c, appId, account, day, 1000n, 137n));

    const snap = await quota.snapshot(appId, account);
    expect(snap.reserved).toBe(0n);
    expect(snap.settled).toBe(137n);

    // Com o teto devolvido, ainda cabe muito mais do que caberia se a quota
    // tivesse sido debitada pelo teto (era o comportamento antigo).
    const again = await tx((c) => quota.reserve(c, appId, account, 4000n, 5000n));
    expect(again).not.toBeNull();
  });

  it('transação que falha libera a reserva inteira', async () => {
    const account = await freshAccount();
    const day = (await pool.query<{ d: string }>(`SELECT ${quota.DAY_SQL}::text AS d`)).rows[0]!.d;

    await tx((c) => quota.reserve(c, appId, account, 900n, 1000n));
    await tx((c) => quota.settle(c, appId, account, day, 900n, 0n));

    const snap = await quota.snapshot(appId, account);
    expect(snap.reserved).toBe(0n);
    expect(snap.settled).toBe(0n);
  });
});

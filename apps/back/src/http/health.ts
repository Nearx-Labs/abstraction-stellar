import { Hono } from 'hono';
import { pool } from '../db/pool.js';
import { server } from '../chain/rpc.js';
import { env } from '../env.js';
import { countDead } from '../db/queries/outbox.js';

export const healthRoutes = new Hono();

/** Liveness: o processo está de pé. */
healthRoutes.get('/health', (c) => c.json({ ok: true, network: env.NETWORK_PASSPHRASE }));

/** Readiness: dá para servir tráfego (banco e RPC respondendo). */
healthRoutes.get('/health/ready', async (c) => {
  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    await pool.query('SELECT 1');
    checks.db = 'ok';
  } catch (error) {
    ok = false;
    checks.db = String(error);
  }

  try {
    const { sequence } = await server.getLatestLedger();
    checks.rpc = { ledger: sequence };
  } catch (error) {
    ok = false;
    checks.rpc = String(error);
  }

  try {
    const dead = await countDead();
    checks.outboxDead = dead;
    // Job morto no outbox não derruba a readiness — é alerta, não indisponibilidade.
  } catch {
    checks.outboxDead = 'desconhecido';
  }

  return c.json({ ok, checks }, ok ? 200 : 503);
});

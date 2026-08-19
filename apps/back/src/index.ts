// Serviço unificado: relayer patrocinado + registry de contas + faucet +
// session keys + emissor de attestations de email.
//
// Os dois processos antigos (relayer-proxy :8787 e auth-issuer :8788) viraram
// um só — mesma origem, mesmo CORS, mesmo banco, um deploy.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { seedDev } from './db/seed.js';
import { pool } from './db/pool.js';
import { allKeys, ensureFundedInDev } from './chain/keys.js';
import { syncChannels } from './db/queries/channels.js';
import { corsMiddleware } from './http/middleware/cors.js';
import { healthRoutes } from './http/health.js';
import { relayRoutes } from './http/relay.js';
import { emailRoutes } from './http/email.js';
import { accountRoutes } from './http/accounts.js';
import { authnRoutes } from './http/authn.js';
import { faucetRoutes } from './http/faucet.js';
import { sessionRoutes } from './http/sessions.js';
import { ledgerRoutes } from './http/ledger.js';
import { masterRoutes } from './http/master.js';
import { startTreasuryOutboxWorker } from './workers/treasuryOutbox.js';
import { startMaintenanceWorker } from './workers/maintenance.js';
import { startSessionSyncWorker } from './workers/sessionSync.js';

const app = new Hono();

app.use('*', corsMiddleware());
app.route('/', healthRoutes);
app.route('/v1', relayRoutes);
app.route('/v1', authnRoutes);
app.route('/v1', accountRoutes);
app.route('/v1', faucetRoutes);
app.route('/v1', sessionRoutes);
app.route('/v1', masterRoutes);
app.route('/v1', ledgerRoutes);
app.route('/v1', emailRoutes);

app.notFound((c) => c.json({ success: false, error: 'rota inexistente', errorCode: 'NOT_FOUND' }, 404));

app.onError((error, c) => {
  logger.error({ err: error.message, stack: error.stack }, 'erro não tratado');
  return c.json({ success: false, error: 'erro interno', errorCode: 'INTERNAL' }, 500);
});

// ── Boot ────────────────────────────────────────────────────────────────────
// A ordem importa: migrar antes de servir, e registrar as contas de serviço
// antes de qualquer lease.
await migrate();
await seedDev();
await ensureFundedInDev();
await syncChannels(allKeys.map(({ role, keypair }) => ({ role, publicKey: keypair.publicKey() })));

const stopWorkers: Array<() => void> = [];
if (env.RUN_WORKERS) {
  stopWorkers.push(startTreasuryOutboxWorker(), startMaintenanceWorker(), startSessionSyncWorker());
}

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, 'abstraction-back no ar');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'encerrando');
  for (const stop of stopWorkers) stop();
  server.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

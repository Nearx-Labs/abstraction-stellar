// Serviço unificado: relayer patrocinado + registry de contas + faucet +
// grants de app + conta mestre + ledger + emissor de attestations de email.
//
// Os dois processos antigos (relayer-proxy :8787 e auth-issuer :8788) viraram
// um só — mesma origem, mesmo CORS, mesmo banco, um deploy.
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { bootstrapApp, bootstrapPanelUser, seedDev } from './db/seed.js';
import { pool } from './db/pool.js';
import { allKeys, ensureFundedInDev } from './chain/keys.js';
import { assertChainConfig } from './chain/preflight.js';
import { syncChannels } from './db/queries/channels.js';
import { startTreasuryOutboxWorker } from './workers/treasuryOutbox.js';
import { startMaintenanceWorker } from './workers/maintenance.js';
import { startSessionSyncWorker } from './workers/sessionSync.js';

const app = buildApp();

// ── Boot ────────────────────────────────────────────────────────────────────
// A ordem importa: migrar antes de servir, e registrar as contas de serviço
// antes de qualquer lease.
await migrate();
await assertChainConfig();
await seedDev();
await bootstrapApp();
await bootstrapPanelUser();
await ensureFundedInDev();
await syncChannels(allKeys.map(({ role, keypair }) => ({ role, publicKey: keypair.publicKey() })));

const stopWorkers: Array<() => void> = [];
if (env.RUN_WORKERS) {
  stopWorkers.push(startTreasuryOutboxWorker(), startMaintenanceWorker(), startSessionSyncWorker());
}

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, 'abstraction-back no ar');
  logger.info(`documentação em http://localhost:${info.port}/docs`);
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

// Montagem do app HTTP, separada do boot.
//
// A separação existe para que o teste de drift da spec OpenAPI possa enumerar
// as rotas registradas sem migrar banco, financiar conta no friendbot nem
// abrir porta.
import { Hono } from 'hono';
import { logger } from './logger.js';
import { corsMiddleware } from './http/middleware/cors.js';
import { healthRoutes } from './http/health.js';
import { docsRoutes } from './http/docs.js';
import { relayRoutes } from './http/relay.js';
import { emailRoutes } from './http/email.js';
import { accountRoutes } from './http/accounts.js';
import { authnRoutes } from './http/authn.js';
import { faucetRoutes } from './http/faucet.js';
import { sessionRoutes } from './http/sessions.js';
import { ledgerRoutes } from './http/ledger.js';
import { masterRoutes } from './http/master.js';

export function buildApp(): Hono {
  const app = new Hono();

  app.use('*', corsMiddleware());
  app.route('/', healthRoutes);
  app.route('/', docsRoutes);
  app.route('/v1', relayRoutes);
  app.route('/v1', authnRoutes);
  app.route('/v1', accountRoutes);
  app.route('/v1', faucetRoutes);
  app.route('/v1', sessionRoutes);
  app.route('/v1', masterRoutes);
  app.route('/v1', ledgerRoutes);
  app.route('/v1', emailRoutes);

  app.notFound((c) =>
    c.json({ success: false, error: 'rota inexistente', errorCode: 'NOT_FOUND' }, 404),
  );

  app.onError((error, c) => {
    logger.error({ err: error.message, stack: error.stack }, 'erro não tratado');
    return c.json({ success: false, error: 'erro interno', errorCode: 'INTERNAL' }, 500);
  });

  return app;
}

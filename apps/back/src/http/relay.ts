// O endpoint que o smart-account-kit chama.
//
// A publishable key vai no PATH e não num header porque o RelayerClient do kit
// (relayer.js) monta o fetch com Content-Type + X-Client-Name +
// X-Client-Version e nada mais — não há gancho para Authorization, cookie ou
// header customizado, e ele posta exatamente na URL configurada em
// `relayerUrl`. Então o app se identifica pelo path:
//
//     relayerUrl = https://api.../v1/relay/pk_test_xxx
//
// A chave é pública por construção. Quem realmente segura o gasto é a
// combinação allowlist de alvos + teto por transação + quota diária por conta +
// allowance on-chain; a key serve para rotear ao app e cortar origem estranha.
import { Hono } from 'hono';
import { resolveByKey } from '../db/queries/apps.js';
import { relay, type RelayBody } from '../relay/pipeline.js';
import { clientIp, hit } from './middleware/rateLimit.js';

const RELAY_LIMIT_PER_MINUTE = 30;

export const relayRoutes = new Hono();

relayRoutes.post('/relay/:publishableKey', async (c) => {
  const pk = c.req.param('publishableKey');

  const resolved = await resolveByKey(pk, 'publishable');
  if (!resolved) {
    return c.json(
      { success: false, error: 'chave de aplicação inválida', errorCode: 'UNAUTHORIZED' },
      401,
    );
  }

  if (!(await hit(`relay:${resolved.app.id}:${clientIp(c)}`, RELAY_LIMIT_PER_MINUTE, 60))) {
    return c.json(
      { success: false, error: 'muitas requisições; aguarde', errorCode: 'RATE_LIMITED' },
      429,
      { 'Retry-After': '60' },
    );
  }

  let body: RelayBody;
  try {
    body = await c.req.json<RelayBody>();
  } catch {
    return c.json({ success: false, error: 'body inválido', errorCode: 'INVALID_PARAMS' }, 400);
  }

  const result = await relay(resolved, body, c.req.header('Idempotency-Key'));
  return c.json(result.body, result.status as 200);
});

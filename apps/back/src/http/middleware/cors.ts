// CORS com origens vindas do banco (app_origins).
//
// Duas armadilhas resolvidas aqui:
//
//  · O `cors()` sem opções do Hono ecoava de volta qualquer
//    Access-Control-Request-Headers. Apertar isso sem listar X-Client-Name e
//    X-Client-Version quebraria 100% das chamadas do smart-account-kit: o
//    RelayerClient manda esses dois headers, eles não são "simples", então
//    disparam preflight.
//
//  · `credentials: true` exige origem específica no Access-Control-Allow-Origin;
//    não pode ser '*'. Como a sessão do painel é cookie httpOnly, isso é
//    obrigatório.
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import { allOrigins } from '../../db/queries/apps.js';
import { isDev } from '../../env.js';
import { logger } from '../../logger.js';

export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  // Mandados pelo RelayerClient do smart-account-kit. Sem eles, o preflight
  // falha e nenhuma transação é submetida.
  'X-Client-Name',
  'X-Client-Version',
];

const CACHE_MS = 30_000;
let cached: { at: number; origins: Set<string> } | null = null;

async function originSet(): Promise<Set<string>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.origins;
  try {
    const origins = new Set(await allOrigins());
    cached = { at: Date.now(), origins };
    return origins;
  } catch (error) {
    logger.error({ err: String(error) }, 'não deu para ler app_origins; negando CORS');
    return cached?.origins ?? new Set();
  }
}

export function corsMiddleware(): MiddlewareHandler {
  return cors({
    origin: async (origin) => {
      if (!origin) return undefined;
      // Em desenvolvimento, qualquer localhost passa — evita ter que cadastrar
      // a porta do Vite toda vez que ela muda.
      if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return (await originSet()).has(origin) ? origin : undefined;
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ALLOWED_HEADERS,
    credentials: true,
    maxAge: 600,
  });
}

// Dois modos de autenticação para os endpoints privilegiados:
//
//  · cookie de sessão (o painel, depois da assertion de passkey);
//  · `Authorization: Bearer sk_…` (chamada servidor-a-servidor).
//
// Os handlers são os mesmos; muda só quem prova a identidade. Isso é o que
// permite o mesmo endpoint servir o front do criador e um backend consumidor.
import { getCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { resolveSession, type PanelSession } from '../../db/queries/panelSessions.js';
import { resolveByKey, type ResolvedApp } from '../../db/queries/apps.js';
import * as accounts from '../../db/queries/accounts.js';

export const SESSION_COOKIE = 'abstraction_session';

export interface Caller {
  appId: string;
  /** Definido quando quem chama é o dono da conta (sessão de painel). */
  session?: PanelSession;
  /** Definido quando quem chama é um serviço com secret key. */
  service?: ResolvedApp;
}

declare module 'hono' {
  interface ContextVariableMap {
    caller: Caller;
  }
}

function unauthorized(c: Context) {
  return c.json({ success: false, error: 'não autenticado', errorCode: 'UNAUTHORIZED' }, 401);
}

/** Aceita cookie de sessão OU secret key. */
export function requireCaller(): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const session = await resolveSession(token);
      if (session) {
        c.set('caller', { appId: session.appId, session });
        return next();
      }
    }

    const header = c.req.header('Authorization');
    if (header?.toLowerCase().startsWith('bearer ')) {
      const key = header.slice(7).trim();
      const service = await resolveByKey(key, 'secret');
      if (service) {
        c.set('caller', { appId: service.app.id, service });
        return next();
      }
    }

    return unauthorized(c);
  };
}

/** Só secret key — para operações que um browser nunca deveria fazer. */
export function requireService(): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.toLowerCase().startsWith('bearer ')) return unauthorized(c);
    const service = await resolveByKey(header.slice(7).trim(), 'secret');
    if (!service) return unauthorized(c);
    c.set('caller', { appId: service.app.id, service });
    await next();
  };
}

/**
 * Garante que o caller pode agir sobre `:address`.
 *
 * Uma sessão de painel só fala pela própria conta; uma secret key fala por
 * qualquer conta do seu app.
 */
export async function assertCanActOn(
  c: Context,
  contractId: string,
): Promise<accounts.SmartAccountRow | null> {
  const caller = c.get('caller');
  if (caller.session && caller.session.contractId !== contractId) return null;
  return accounts.byContractId(caller.appId, contractId);
}

// Guarda da spec OpenAPI.
//
// Documentação escrita à mão apodrece em silêncio: alguém adiciona uma rota,
// esquece de documentar, e o consumidor descobre pelo 404. Aqui a spec é
// comparada com as rotas REALMENTE registradas no Hono (`app.routes`) — rota
// sem documentação, ou documentação de rota que não existe mais, quebra o CI.
import { describe, expect, it } from 'vitest';

const { buildApp } = await import('../src/app.js');
const { openapi } = await import('../src/openapi.js');

/** `/v1/accounts/:address` (Hono) → `/v1/accounts/{address}` (OpenAPI). */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** Rotas do app, sem middlewares (que o Hono registra com method ALL). */
function registeredRoutes(): Set<string> {
  const app = buildApp() as unknown as {
    routes: Array<{ method: string; path: string; handler: { name?: string } }>;
  };

  const out = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    out.add(`${route.method} ${toOpenApiPath(route.path)}`);
  }
  return out;
}

function documentedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const [path, operations] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(operations)) {
      out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

describe('spec OpenAPI', () => {
  it('documenta exatamente as rotas registradas', () => {
    const registered = registeredRoutes();
    const documented = documentedRoutes();

    // `/openapi.json` e `/docs` servem a própria documentação; documentá-las
    // dentro dela seria ruído.
    const selfServing = new Set(['GET /openapi.json', 'GET /docs']);

    const undocumented = [...registered].filter(
      (route) => !documented.has(route) && !selfServing.has(route),
    );
    const stale = [...documented].filter((route) => !registered.has(route));

    expect(undocumented, 'rotas registradas e não documentadas').toEqual([]);
    expect(stale, 'rotas documentadas que não existem mais').toEqual([]);
  });

  it('toda operação declara tag, resumo e respostas', () => {
    for (const [path, operations] of Object.entries(openapi.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const op = operation as { tags?: string[]; summary?: string; responses?: object };
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.tags?.length, `${where} sem tag`).toBeGreaterThan(0);
        expect(op.summary, `${where} sem resumo`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${where} sem respostas`).toBeGreaterThan(0);
      }
    }
  });

  it('toda tag usada está declarada no topo', () => {
    const declared = new Set(openapi.tags.map((tag) => tag.name));
    for (const operations of Object.values(openapi.paths)) {
      for (const operation of Object.values(operations)) {
        for (const tag of (operation as { tags?: string[] }).tags ?? []) {
          expect(declared.has(tag), `tag não declarada: ${tag}`).toBe(true);
        }
      }
    }
  });

  it('todo $ref aponta para um schema existente', () => {
    const schemas = new Set(Object.keys(openapi.components.schemas));
    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)];

    expect(refs.length, 'a spec deveria referenciar schemas').toBeGreaterThan(0);
    for (const [, name] of refs) {
      expect(schemas.has(name!), `$ref quebrado: ${name}`).toBe(true);
    }
  });

  it('endpoints que gastam recurso não ficam sem autenticação', () => {
    // Estes são públicos de propósito: o relay é chamado pelo kit, que não
    // manda header, e o resto é leitura.
    const intentionallyPublic = new Set([
      'POST /v1/relay/{publishableKey}',
      'POST /v1/authn/challenge',
      'POST /v1/authn/verify',
      // O login por senha é a porta de entrada: exigir sessão aqui seria circular.
      'POST /v1/authn/password',
      'POST /v1/accounts',
      'GET /v1/ledger',
      'GET /v1/ledger/{uuid}',
      'GET /v1/accounts/{address}/ledger',
      'GET /v1/email/issuer',
      'POST /v1/email/request',
      'POST /v1/email/verify',
      'POST /v1/email/attest',
      'GET /health',
      'GET /health/ready',
    ]);

    for (const [path, operations] of Object.entries(openapi.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const where = `${method.toUpperCase()} ${path}`;
        if (intentionallyPublic.has(where)) continue;
        const security = (operation as { security?: unknown[] }).security;
        expect(security?.length, `${where} sem autenticação declarada`).toBeGreaterThan(0);
      }
    }
  });
});

// A spec OpenAPI servida pela própria API, e uma página para lê-la.
//
// Servir daqui — em vez de só commitar um arquivo — garante que o que o
// consumidor lê é o que este processo está rodando.
import { Hono } from 'hono';
import { openapi } from '../openapi.js';

export const docsRoutes = new Hono();

docsRoutes.get('/openapi.json', (c) => c.json(openapi));

docsRoutes.get('/docs', (c) =>
  c.html(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Abstraction API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/openapi.json',
        theme: 'deepSpace',
      });
    </script>
  </body>
</html>`),
);

// Upload de mídia dos itens.
//
// O contrato não guarda arquivo — guarda a URI. Um Soroban cobra por byte
// armazenado, então imagem on-chain é economicamente inviável, e o limite de
// 512 caracteres do campo `uri` é proposital: quem paga a fee é o sponsor.
//
// Então o fluxo é: o arquivo sobe para cá, a resposta devolve uma URL estável,
// e é essa URL que entra no contrato. O conteúdo é endereçado por sha256 — o
// mesmo arquivo enviado duas vezes devolve a mesma URL em vez de duplicar.
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { env } from '../env.js';
import { resolveByKey } from '../db/queries/apps.js';
import { clientIp, hit } from './middleware/rateLimit.js';
import { logger } from '../logger.js';

export const mediaRoutes = new Hono();

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Só imagem, e só formatos que o browser renderiza sem plugin. SVG fica de
 * fora porque é executável: um SVG hospedado no nosso domínio roda script no
 * contexto dele.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

mediaRoutes.post('/media', async (c) => {
  if (!(await hit(`media:${clientIp(c)}`, 30, 3600))) {
    return c.json(
      { success: false, error: 'muitos envios; aguarde', errorCode: 'RATE_LIMITED' },
      429,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { success: false, error: 'envie multipart/form-data', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json(
      { success: false, error: 'campo "file" ausente', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  if (file.size > MAX_BYTES) {
    return c.json(
      {
        success: false,
        error: `arquivo acima de ${Math.floor(MAX_BYTES / 1024 / 1024)}MB`,
        errorCode: 'FILE_TOO_LARGE',
      },
      413,
    );
  }

  if (!ALLOWED.has(file.type)) {
    return c.json(
      {
        success: false,
        error: `tipo ${file.type || 'desconhecido'} não aceito`,
        errorCode: 'UNSUPPORTED_TYPE',
      },
      415,
    );
  }

  // A publishable key identifica o app; o upload é anônimo como o relay, com
  // rate limit por IP e teto de tamanho segurando o abuso.
  const publishableKey = form.get('publishableKey');
  const resolved =
    typeof publishableKey === 'string' ? await resolveByKey(publishableKey, 'publishable') : null;

  const bytes = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest();

  const res = await pool.query<{ id: string }>(
    `INSERT INTO media (app_id, content_hash, mime_type, byte_size, filename, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_id, content_hash) DO UPDATE SET filename = EXCLUDED.filename
     RETURNING id`,
    [resolved?.app.id ?? null, hash, file.type, bytes.length, file.name.slice(0, 200), bytes],
  );

  const id = res.rows[0]!.id;
  const extension = EXTENSIONS[file.type] ?? 'bin';
  const url = `${env.PUBLIC_URL.replace(/\/+$/, '')}/v1/media/${id}.${extension}`;

  logger.info({ id, bytes: bytes.length, mime: file.type }, 'mídia recebida');
  return c.json({ success: true, id, url, byteSize: bytes.length, mimeType: file.type });
});

mediaRoutes.get('/media/:file', async (c) => {
  // A extensão existe só para o item ficar com uma URL de cara familiar; o id
  // é o que identifica.
  const id = (c.req.param('file') ?? '').split('.')[0] ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return c.json({ success: false, error: 'id inválido', errorCode: 'INVALID_PARAMS' }, 400);
  }

  const res = await pool.query<{ data: Buffer | null; mime_type: string; external_url: string | null }>(
    'SELECT data, mime_type, external_url FROM media WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  if (!row) {
    return c.json({ success: false, error: 'não encontrado', errorCode: 'NOT_FOUND' }, 404);
  }
  if (row.external_url) return c.redirect(row.external_url, 302);
  if (!row.data) {
    return c.json({ success: false, error: 'sem conteúdo', errorCode: 'NOT_FOUND' }, 404);
  }

  return c.body(new Uint8Array(row.data), 200, {
    'Content-Type': row.mime_type,
    // Conteúdo é imutável (endereçado por hash), então cache longo é seguro.
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
});

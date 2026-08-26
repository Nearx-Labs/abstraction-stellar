// Versão publicada na spec OpenAPI. Lida do package.json para não divergir.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const version = pkg.version;

/**
 * Commit que gerou a imagem, injetado no build (`ARG GIT_SHA`).
 *
 * Existe porque "qual build está rodando?" não tinha resposta de fora: a versão
 * do package.json não muda a cada deploy, e sem isto a única saída era pedir o
 * log do container para alguém. Já custou uma rodada de ida e volta.
 */
export const commit = process.env.GIT_SHA || 'desconhecido';

// Versão publicada na spec OpenAPI. Lida do package.json para não divergir.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const version = pkg.version;

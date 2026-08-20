// `npm run openapi:export` — grava a spec em openapi.json na raiz do serviço.
//
// Útil para gerar cliente e para versionar o diff da API junto do código.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openapi } from '../src/openapi.js';

const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
await writeFile(target, `${JSON.stringify(openapi, null, 2)}\n`);
process.stdout.write(`spec gravada em ${target}\n`);

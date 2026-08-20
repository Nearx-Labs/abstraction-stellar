// `npm run migrate` — aplica as migrações e sai. Útil em CI e em job de deploy;
// o serviço também migra sozinho no boot.
import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { logger } from '../logger.js';

try {
  await migrate();
  logger.info('migrações em dia');
} catch (error) {
  logger.error({ err: String(error) }, 'migração falhou');
  process.exitCode = 1;
} finally {
  await pool.end();
}

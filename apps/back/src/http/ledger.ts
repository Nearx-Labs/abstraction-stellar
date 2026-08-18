// O "fake ledger": a listagem dos mints do contrato demo-ledger.
//
// A leitura é pública de propósito — um ledger que só o dono enxerga não
// demonstra nada. O que é privado continua privado: quota, faucet e sessões
// seguem exigindo autenticação.
import { Hono } from 'hono';
import { env } from '../env.js';
import * as ledger from '../chain/ledger.js';

export const ledgerRoutes = new Hono();

function ledgerId(): string | undefined {
  return env.DEMO_LEDGER_CONTRACT_ID;
}

function notConfigured() {
  return {
    success: false as const,
    error: 'DEMO_LEDGER_CONTRACT_ID não configurado',
    errorCode: 'NOT_CONFIGURED',
  };
}

ledgerRoutes.get('/ledger', async (c) => {
  const contractId = ledgerId();
  if (!contractId) return c.json(notConfigured(), 409);

  const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const owner = c.req.query('owner');

  const [total, records] = await Promise.all([
    ledger.totalSupply(contractId),
    ledger.page(contractId, offset, limit),
  ]);

  // O filtro por dono é aplicado sobre a página, não no contrato: para um POC
  // isso basta, e evita uma segunda leitura on-chain por item.
  const items = owner ? records.filter((record) => record.owner === owner) : records;

  return c.json({ success: true, contractId, total, offset, limit, items });
});

ledgerRoutes.get('/ledger/:id', async (c) => {
  const contractId = ledgerId();
  if (!contractId) return c.json(notConfigured(), 409);

  const record = await ledger.getRecord(contractId, Number(c.req.param('id')));
  if (!record) {
    return c.json({ success: false, error: 'registro não encontrado', errorCode: 'NOT_FOUND' }, 404);
  }
  return c.json({ success: true, contractId, record });
});

ledgerRoutes.get('/accounts/:address/ledger', async (c) => {
  const contractId = ledgerId();
  if (!contractId) return c.json(notConfigured(), 409);

  const ids = await ledger.recordsOf(contractId, c.req.param('address'));
  const records = await Promise.all(
    ids.slice(-25).reverse().map((id) => ledger.getRecord(contractId, id)),
  );
  return c.json({
    success: true,
    contractId,
    total: ids.length,
    items: records.filter((record) => record !== null),
  });
});

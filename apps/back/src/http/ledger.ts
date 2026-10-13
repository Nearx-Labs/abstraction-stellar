// O "fake ledger": a listagem dos mints do contrato demo-ledger.
//
// A leitura é pública de propósito — um ledger que só o dono enxerga não
// demonstra nada. O que é privado continua privado: quota, faucet e sessões
// seguem exigindo autenticação.
import { Hono } from 'hono';
import { env } from '../env.js';
import * as ledger from '../chain/ledger.js';
import { mintTxHashOf } from '../db/queries/master.js';

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

  const limit = Math.min(Number(c.req.query('limit') ?? 20), 40);
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

ledgerRoutes.get('/ledger/:uuid', async (c) => {
  const contractId = ledgerId();
  if (!contractId) return c.json(notConfigured(), 409);

  const uuid = c.req.param('uuid');
  const record = await ledger.getRecord(contractId, uuid);
  if (!record) {
    return c.json({ success: false, error: 'registro não encontrado', errorCode: 'NOT_FOUND' }, 404);
  }
  // O contrato não guarda o hash da transação que mintou; o serviço guarda. É
  // o que o consumidor usa para montar o link do explorer depois de um retry.
  const mintTxHash = await mintTxHashOf(uuid);
  return c.json({ success: true, contractId, record: { ...record, mintTxHash } });
});

ledgerRoutes.get('/accounts/:address/ledger', async (c) => {
  const contractId = ledgerId();
  if (!contractId) return c.json(notConfigured(), 409);

  const address = c.req.param('address');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25), 1), 50);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const [total, uuids] = await Promise.all([
    ledger.balanceOf(contractId, address),
    ledger.recordsOf(contractId, address, offset, limit),
  ]);
  const records = await Promise.all(uuids.map((uuid) => ledger.getRecord(contractId, uuid)));
  return c.json({
    success: true,
    contractId,
    total,
    offset,
    limit,
    items: records.filter((record) => record !== null),
  });
});

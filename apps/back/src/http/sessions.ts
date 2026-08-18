// Session keys — metadados e orçamento restante.
//
// O grant e a revogação são assinados no browser (é a passkey do dono que
// autoriza); o back registra o metadado e serve a leitura consolidada, que
// inclui uma simulação do spending-limit-policy para dizer quanto ainda cabe.
import { Hono } from 'hono';
import * as grants from '../db/queries/sessionGrants.js';
import { getSpendingLimitData } from '../chain/account.js';
import { LEDGER_SECONDS, currentLedger } from '../chain/rpc.js';
import { assertCanActOn, requireCaller } from './middleware/auth.js';

export const sessionRoutes = new Hono();

const C_ADDRESS = /^C[A-Z2-7]{55}$/;

sessionRoutes.get('/accounts/:address/sessions', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const [rows, ledger] = await Promise.all([grants.listFor(account.id), currentLedger()]);

  const items = await Promise.all(
    rows.map(async (row) => {
      const budget =
        row.contextRuleId === null || row.state !== 'active'
          ? null
          : await getSpendingLimitData(row.policyAddress, row.contextRuleId, address);

      const remainingLedgers = Number(row.validUntilLedger) - ledger;
      return {
        id: row.id,
        contextRuleId: row.contextRuleId,
        name: row.name,
        targetContract: row.targetContract,
        publicKey: row.ed25519PublicKey.toString('hex'),
        state: row.state,
        spendingLimitStroops: row.spendingLimitStroops.toString(),
        spentStroops: budget ? budget.totalSpent.toString() : null,
        remainingStroops: budget
          ? (budget.spendingLimit - budget.totalSpent).toString()
          : null,
        validUntilLedger: row.validUntilLedger.toString(),
        expiresInSeconds: remainingLedgers > 0 ? remainingLedgers * LEDGER_SECONDS : 0,
        grantTxHash: row.grantTxHash,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );

  return c.json({ success: true, currentLedger: ledger, items });
});

sessionRoutes.post('/accounts/:address/sessions', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const caller = c.get('caller');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const body = await c.req.json<{
    contextRuleId?: number;
    name?: string;
    targetContract?: string;
    ed25519PublicKey?: string;
    policyAddress?: string;
    spendingLimitStroops?: string;
    periodLedgers?: number;
    validUntilLedger?: string;
    grantTxHash?: string;
  }>();

  if (
    !body.name ||
    !body.targetContract ||
    !C_ADDRESS.test(body.targetContract) ||
    !body.ed25519PublicKey ||
    !body.policyAddress ||
    !body.spendingLimitStroops ||
    !body.periodLedgers ||
    !body.validUntilLedger
  ) {
    return c.json(
      { success: false, error: 'campos obrigatórios ausentes', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  const publicKey = Buffer.from(body.ed25519PublicKey.replace(/^0x/, ''), 'hex');
  if (publicKey.length !== 32) {
    return c.json(
      { success: false, error: 'ed25519PublicKey deve ter 32 bytes', errorCode: 'INVALID_PARAMS' },
      400,
    );
  }

  const ledger = await currentLedger();
  const validUntilLedger = BigInt(body.validUntilLedger);
  const validUntilEst = new Date(
    Date.now() + Math.max(Number(validUntilLedger) - ledger, 0) * LEDGER_SECONDS * 1000,
  );

  const created = await grants.create({
    appId: caller.appId,
    accountId: account.id,
    smartAccount: address,
    contextRuleId: body.contextRuleId ?? null,
    name: body.name.slice(0, 32),
    targetContract: body.targetContract,
    ed25519PublicKey: publicKey,
    policyAddress: body.policyAddress,
    spendingLimitStroops: BigInt(body.spendingLimitStroops),
    periodLedgers: body.periodLedgers,
    validUntilLedger,
    validUntilEst,
    grantTxHash: body.grantTxHash ?? null,
  });

  return c.json({ success: true, id: created.id, state: created.state });
});

sessionRoutes.delete('/accounts/:address/sessions/:ruleId', requireCaller(), async (c) => {
  const address = c.req.param('address');
  const account = await assertCanActOn(c, address);
  if (!account) {
    return c.json({ success: false, error: 'conta não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const ruleId = Number(c.req.param('ruleId'));
  const grant = await grants.byRuleId(account.id, ruleId);
  if (!grant) {
    return c.json({ success: false, error: 'sessão não encontrada', errorCode: 'NOT_FOUND' }, 404);
  }

  const txHash = c.req.query('txHash');
  await grants.markRevoked(grant.id, txHash);
  return c.json({ success: true });
});

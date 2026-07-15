// Relayer Proxy — submissão patrocinada com policy (Fase 3).
//
// Compatível com o protocolo do smart-account-kit (relayerUrl): um único
// endpoint POST que aceita `{func, auth}` (o proxy monta e paga a transação)
// ou `{xdr}` (o proxy envelopa em fee-bump). Antes de pagar, aplica a policy
// off-chain (allowlist de alvos, teto por tx, quota diária por conta) e, se
// TREASURY_CONTRACT_ID estiver definido, debita o consumo on-chain via
// Treasury.consume — o payer deve ser o operator do Treasury.
//
// Em produção com OZ Channels: defina CHANNELS_URL/CHANNELS_API_KEY e o
// proxy passa a encaminhar a submissão (a policy continua sendo aplicada
// aqui, na frente).
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { xdr } from '@stellar/stellar-sdk';
import { enforcePolicy, loadPolicy, PolicyError, recordSpend, spentToday } from './policy.js';
import {
  debitTreasury,
  loadFeePayer,
  parseHostFunction,
  parseTransactionIntent,
  submitFeeBump,
  submitHostFunction,
} from './stellar.js';

const PORT = Number(process.env.PORT ?? 8787);
const CHANNELS_URL = process.env.CHANNELS_URL;
const CHANNELS_API_KEY = process.env.CHANNELS_API_KEY;
const TREASURY_CONTRACT_ID = process.env.TREASURY_CONTRACT_ID;

const policy = loadPolicy();
if (policy.targetAllowlist.size === 0) {
  console.warn('[relayer-proxy] TARGET_ALLOWLIST vazio — patrocinando QUALQUER contrato (dev)');
}

const payer = await loadFeePayer();
console.log(`[relayer-proxy] fee payer: ${payer.publicKey()}`);

const app = new Hono();
app.use('*', cors());

app.get('/health', (c) =>
  c.json({
    ok: true,
    feePayer: payer.publicKey(),
    policy: {
      targets: [...policy.targetAllowlist],
      maxFeePerTx: policy.maxFeePerTx.toString(),
      maxFeePerDay: policy.maxFeePerDay.toString(),
    },
    treasury: TREASURY_CONTRACT_ID ?? null,
    mode: CHANNELS_URL ? 'forward-channels' : 'local-submit',
  }),
);

app.get('/quota/:user', (c) =>
  c.json({
    user: c.req.param('user'),
    spentToday: spentToday(c.req.param('user')).toString(),
    maxFeePerDay: policy.maxFeePerDay.toString(),
  }),
);

async function forwardToChannels(body: unknown) {
  const res = await fetch(CHANNELS_URL!, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CHANNELS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

app.post('/', async (c) => {
  const body = await c.req.json<{ func?: string; auth?: string[]; xdr?: string }>();

  try {
    if (body.func) {
      // Modo Channels: o proxy monta, simula, paga e submete.
      const hostFn = xdr.HostFunction.fromXDR(body.func, 'base64');
      const authEntries = (body.auth ?? []).map((a) =>
        xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64'),
      );
      const intent = parseHostFunction(hostFn, authEntries);

      const { prepared, send } = await submitHostFunction(payer, hostFn, authEntries);
      enforcePolicy(policy, intent.targets, intent.user, BigInt(prepared.fee));

      if (CHANNELS_URL) {
        const fwd = await forwardToChannels({ func: body.func, auth: body.auth });
        return c.json(fwd.json, fwd.status as 200);
      }
      const outcome = await send();
      recordSpend(intent.user, outcome.fee);
      if (TREASURY_CONTRACT_ID && intent.user && intent.targets[0]) {
        void debitTreasury(payer, TREASURY_CONTRACT_ID, intent.user, intent.targets[0], outcome.fee);
      }
      return c.json({ success: true, hash: outcome.hash, status: outcome.status });
    }

    if (body.xdr) {
      // Modo fee-bump: preserva a assinatura interna (ex.: deploy da conta).
      const { inner, send } = await submitFeeBump(payer, body.xdr);
      const intent = parseTransactionIntent(inner);
      enforcePolicy(policy, intent.targets, intent.user, BigInt(inner.fee));

      if (CHANNELS_URL) {
        const fwd = await forwardToChannels({ xdr: body.xdr });
        return c.json(fwd.json, fwd.status as 200);
      }
      const outcome = await send();
      recordSpend(intent.user, outcome.fee);
      if (TREASURY_CONTRACT_ID && intent.user && intent.targets[0]) {
        void debitTreasury(payer, TREASURY_CONTRACT_ID, intent.user, intent.targets[0], outcome.fee);
      }
      return c.json({ success: true, hash: outcome.hash, status: outcome.status });
    }

    return c.json(
      { success: false, error: 'body deve conter {func, auth} ou {xdr}', errorCode: 'INVALID_PARAMS' },
      400,
    );
  } catch (err) {
    if (err instanceof PolicyError) {
      return c.json({ success: false, error: err.message, errorCode: err.code }, 403);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[relayer-proxy] erro:', message);
    return c.json({ success: false, error: message, errorCode: 'ONCHAIN_FAILED' }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[relayer-proxy] ouvindo em http://localhost:${PORT}`);
});

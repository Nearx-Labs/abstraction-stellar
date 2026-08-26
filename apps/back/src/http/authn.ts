// Login do painel: por passkey ou por e-mail e senha.
//
// Fluxo: /authn/challenge devolve um nonce e as credenciais aceitas; o browser
// chama navigator.credentials.get() com esse nonce; /authn/verify confere a
// assertion e devolve um cookie httpOnly.
//
// Isto é independente do smart-account-kit: mesma passkey, mesmo rpId, mas a
// cerimônia é a padrão do WebAuthn, sem envolver auth entry de Soroban.
//
// O caminho de senha (`/authn/password`) existe para a conta mestre custodial,
// que não tem passkey registrada — é provisionada pelo serviço com chave
// derivada, e sem ele o dono não conseguiria abrir o próprio painel. Os dois
// caminhos emitem a MESMA sessão; o que muda é o que o browser consegue
// assinar depois (nada, no caso custodial — quem assina é o serviço).
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { env, isDev } from '../env.js';
import * as accounts from '../db/queries/accounts.js';
import * as panel from '../db/queries/panelSessions.js';
import * as panelCredentials from '../db/queries/panelCredentials.js';
import { verifyAssertion } from '../webauthn/verify.js';
import { SESSION_COOKIE, requireCaller } from './middleware/auth.js';
import { clientIp, rateLimit } from './middleware/rateLimit.js';
import { resolveByKey } from '../db/queries/apps.js';

export const authnRoutes = new Hono();

function expectedOrigins(): string[] {
  return env.RP_ORIGINS.length > 0
    ? env.RP_ORIGINS
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

authnRoutes.post(
  '/authn/challenge',
  rateLimit({ name: 'authn-challenge', limit: 20, windowSeconds: 60 }),
  async (c) => {
    const { contractId, publishableKey } = await c.req.json<{
      contractId?: string;
      publishableKey?: string;
    }>();
    if (!contractId || !publishableKey) {
      return c.json(
        { success: false, error: 'contractId e publishableKey são obrigatórios', errorCode: 'INVALID_PARAMS' },
        400,
      );
    }

    const resolved = await resolveByKey(publishableKey, 'publishable');
    if (!resolved) {
      return c.json({ success: false, error: 'chave inválida', errorCode: 'UNAUTHORIZED' }, 401);
    }

    const account = await accounts.byContractId(resolved.app.id, contractId);
    if (!account) {
      return c.json(
        { success: false, error: 'conta não registrada', errorCode: 'ACCOUNT_NOT_FOUND' },
        404,
      );
    }

    const credentials = await accounts.credentialsFor(account.id);
    const nonce = await panel.createChallenge(contractId);

    return c.json({
      challenge: nonce.toString('base64url'),
      rpId: env.RP_ID,
      allowCredentials: credentials.map((cred) => ({ id: cred.credentialId, type: 'public-key' })),
    });
  },
);

authnRoutes.post(
  '/authn/verify',
  rateLimit({ name: 'authn-verify', limit: 20, windowSeconds: 60 }),
  async (c) => {
    const body = await c.req.json<{
      credentialId?: string;
      authenticatorData?: string;
      clientDataJSON?: string;
      signature?: string;
      challenge?: string;
    }>();

    if (
      !body.credentialId ||
      !body.authenticatorData ||
      !body.clientDataJSON ||
      !body.signature ||
      !body.challenge
    ) {
      return c.json(
        { success: false, error: 'assertion incompleta', errorCode: 'INVALID_PARAMS' },
        400,
      );
    }

    const credential = await accounts.credentialById(body.credentialId);
    if (!credential) {
      return c.json(
        { success: false, error: 'credencial desconhecida', errorCode: 'UNAUTHORIZED' },
        401,
      );
    }

    const challenge = Buffer.from(body.challenge, 'base64url');
    const claimed = await panel.consumeChallenge(challenge);
    if (!claimed || claimed.contractId !== credential.contractId) {
      return c.json(
        { success: false, error: 'challenge inválido ou já usado', errorCode: 'UNAUTHORIZED' },
        401,
      );
    }

    const result = verifyAssertion({
      authenticatorData: body.authenticatorData,
      clientDataJSON: body.clientDataJSON,
      signature: body.signature,
      publicKeyRaw: credential.publicKeyRaw,
      expectedChallenge: challenge,
      expectedOrigins: expectedOrigins(),
      expectedRpId: env.RP_ID,
    });

    if (!result.ok) {
      return c.json(
        { success: false, error: `assertion recusada: ${result.reason}`, errorCode: 'UNAUTHORIZED' },
        401,
      );
    }

    if (result.signCount !== undefined && result.signCount > 0) {
      await accounts.bumpSignCount(credential.credentialId, result.signCount);
    }

    const token = await panel.createSession(
      credential.accountId,
      env.SESSION_TTL_HOURS,
      clientIp(c),
      c.req.header('User-Agent'),
    );

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: !isDev,
      path: '/',
      maxAge: env.SESSION_TTL_HOURS * 3600,
    });

    return c.json({ success: true, contractId: credential.contractId });
  },
);

authnRoutes.post(
  '/authn/password',
  // Mais apertado que os outros: aqui a tentativa é barata para quem ataca.
  rateLimit({ name: 'authn-password', limit: 10, windowSeconds: 60 }),
  async (c) => {
    const { email, password } = await c.req.json<{ email?: string; password?: string }>();

    if (!email || !password) {
      return c.json(
        { success: false, error: 'email e password são obrigatórios', errorCode: 'INVALID_PARAMS' },
        400,
      );
    }

    const credential = await panelCredentials.authenticate(email, password);
    if (!credential) {
      // Mesma resposta para e-mail inexistente e senha errada.
      return c.json(
        { success: false, error: 'e-mail ou senha inválidos', errorCode: 'UNAUTHORIZED' },
        401,
      );
    }

    const token = await panel.createSession(
      credential.accountId,
      env.SESSION_TTL_HOURS,
      clientIp(c),
      c.req.header('User-Agent'),
    );

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: !isDev,
      path: '/',
      maxAge: env.SESSION_TTL_HOURS * 3600,
    });

    return c.json({ success: true, contractId: credential.contractId, custodial: true });
  },
);

/**
 * Quem está logado nesta sessão.
 *
 * O painel precisa disto para sobreviver a um reload: com passkey a conta é
 * restaurada do IndexedDB do kit, mas numa sessão custodial o browser não tem
 * estado nenhum — o cookie httpOnly é tudo, e ele não é legível por JS.
 *
 * `custodial` é derivado da ausência de passkey na conta, que é exatamente o
 * que a palavra significa aqui: ninguém além da plataforma pode assinar por ela.
 */
authnRoutes.get('/authn/session', requireCaller(), async (c) => {
  const { session } = c.get('caller');
  if (!session) {
    return c.json(
      { success: false, error: 'esta rota é da sessão do painel', errorCode: 'UNAUTHORIZED' },
      401,
    );
  }

  const credentials = await accounts.credentialsFor(session.accountId);

  return c.json({
    success: true,
    contractId: session.contractId,
    custodial: credentials.length === 0,
  });
});

authnRoutes.post('/authn/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await panel.revokeSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

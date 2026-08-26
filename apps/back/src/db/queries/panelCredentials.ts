// Credencial de e-mail e senha do painel.
//
// Existe porque a conta mestre custodial não tem passkey: ela é provisionada
// pelo serviço, com chave derivada, e o tenant nunca registrou digital. Sem
// isto o dono não consegue abrir o próprio painel.
//
// O que este login prova é "quem é o humano", não "quem controla a chave". No
// modelo custodial quem controla a chave é a plataforma — e é por isso que a
// sessão emitida aqui não habilita assinar nada no browser: ela dá acesso de
// leitura e às operações que o SERVIÇO executa em nome da conta.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from '../pool.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** `salt:hash`, ambos em hex. scrypt é do Node — sem dependência nova. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Confere a senha em tempo constante.
 *
 * `timingSafeEqual` estoura se os buffers têm tamanhos diferentes, o que já
 * seria um vazamento por exceção — daí a checagem de tamanho antes.
 */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

export interface PanelCredential {
  id: string;
  accountId: string;
  contractId: string;
  appId: string;
  email: string;
}

/** Cria (ou troca a senha de) um login. */
export async function upsert(input: {
  accountId: string;
  email: string;
  password: string;
}): Promise<{ id: string }> {
  const passwordHash = await hashPassword(input.password);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO panel_credentials (account_id, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (lower(email))
       DO UPDATE SET password_hash = EXCLUDED.password_hash,
                     account_id    = EXCLUDED.account_id
     RETURNING id`,
    [input.accountId, input.email, passwordHash],
  );
  return res.rows[0]!;
}

/**
 * Autentica e devolve a conta, ou `null`.
 *
 * Um único `null` para "e-mail não existe" e para "senha errada": distinguir os
 * dois transforma o login num enumerador de e-mails cadastrados.
 */
export async function authenticate(
  email: string,
  password: string,
): Promise<PanelCredential | null> {
  const res = await pool.query<{
    id: string;
    account_id: string;
    contract_id: string;
    app_id: string;
    email: string;
    password_hash: string;
  }>(
    `SELECT c.id, c.account_id, c.email, c.password_hash,
            a.contract_id, a.app_id
       FROM panel_credentials c
       JOIN smart_accounts a ON a.id = c.account_id
      WHERE lower(c.email) = lower($1)`,
    [email],
  );

  const row = res.rows[0];
  if (!row) {
    // Gasta o mesmo tempo do caminho feliz: sem isto, a resposta imediata para
    // e-mail inexistente entrega quais e-mails existem.
    await verifyPassword(password, `${'00'.repeat(16)}:${'00'.repeat(KEY_LENGTH)}`);
    return null;
  }

  if (!(await verifyPassword(password, row.password_hash))) return null;

  void pool
    .query('UPDATE panel_credentials SET last_login_at = now() WHERE id = $1', [row.id])
    .catch(() => {});

  return {
    id: row.id,
    accountId: row.account_id,
    contractId: row.contract_id,
    appId: row.app_id,
    email: row.email,
  };
}

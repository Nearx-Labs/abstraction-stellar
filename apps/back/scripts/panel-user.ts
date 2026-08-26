// Cria (ou troca a senha de) um login do painel.
//
//   npm run panel:user -- --app demo --email pedro@exemplo.com --password segredo
//
// Por padrão amarra o login à CONTA MESTRE do app — que é a conta custodial,
// sem passkey, e portanto a que precisa deste caminho. `--account C…` aponta
// para outra conta do mesmo app.
//
// A senha entra por argumento porque isto é operação de setup, rodada por quem
// já tem acesso ao banco. Não é fluxo de usuário final.
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import * as accounts from '../src/db/queries/accounts.js';
import * as panelCredentials from '../src/db/queries/panelCredentials.js';
import { resolveBySlug } from '../src/db/queries/apps.js';
import * as master from '../src/db/queries/master.js';

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\n` +
      'uso: npm run panel:user -- --app <slug> --email <email> --password <senha> [--account C…]\n',
  );
  process.exit(1);
}

function parse(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${arg} precisa de valor`);
    values[arg.slice(2)] = value;
    i += 1;
  }
  return values;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const slug = options.app ?? 'demo';
  const { email, password } = options;

  if (!email) usage('--email é obrigatório');
  if (!password) usage('--password é obrigatório');
  if (password.length < 8) usage('--password precisa de ao menos 8 caracteres');

  await migrate();

  const app = await resolveBySlug(slug);
  if (!app) usage(`app "${slug}" não existe — rode npm run app:create antes`);

  const contractId = options.account ?? (await master.masterAccountOf(app.app.id));
  if (!contractId) {
    usage(
      `o app "${slug}" ainda não tem conta mestre. ` +
        'Rode POST /v1/master/provision (ou passe --account C…).',
    );
  }

  let account = await accounts.byContractId(app.app.id, contractId);
  if (!account) {
    // A conta mestre provisionada pelo serviço vive em `apps.master_account`;
    // ela só entra em `smart_accounts` quando alguém a registra. Como o login
    // aponta para uma linha de lá, registramos aqui em vez de exigir um passo
    // extra que ninguém adivinharia.
    await accounts.upsert({
      appId: app.app.id,
      contractId,
      label: `conta mestre de ${slug}`,
      status: 'deployed',
    });
    account = await accounts.byContractId(app.app.id, contractId);
  }
  if (!account) usage(`não consegui registrar a conta ${contractId}`);

  await panelCredentials.upsert({ accountId: account.id, email, password });

  process.stdout.write(
    [
      '',
      `login do painel pronto para ${slug}`,
      `  e-mail  ${email}`,
      `  conta   ${contractId}`,
      '',
      '  Entre em http://localhost:5173 pela aba "E-mail e senha".',
      '',
    ].join('\n'),
  );
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });

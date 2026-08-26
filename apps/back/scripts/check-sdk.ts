// Falha se houver mais de uma cópia do @stellar/stellar-sdk na árvore.
//
//   npm run check-sdk
//
// Não é higiene de dependência — é um bug de runtime esperando acontecer, e um
// que não aponta para a causa. O kit e este serviço trocam objetos XDR; se cada
// um carregar sua cópia do sdk, as classes têm identidades diferentes e a
// escrita falha com mensagens como:
//
//   XDR Write Error: 15259266646457875 is not a Hyper
//   cannot interpret n3 value as ScVal
//
// Nenhuma das duas menciona duplicação. Já mordeu: o back estava em ^14.6.1 e o
// kit exigia 16.0.1, o npm aninhou a segunda cópia, e TODA assinatura como
// conta mestre morria — sem que nenhum teste percebesse, porque o caminho só é
// exercitado contra a rede.
//
// A regra prática: a versão aqui, no apps/front e a que o kit pede têm que ser
// a mesma.
import { execFileSync } from 'node:child_process';

interface LsOutput {
  dependencies?: Record<string, LsOutput & { version?: string }>;
  version?: string;
}

const PACKAGE = '@stellar/stellar-sdk';

function collect(node: LsOutput, found: Map<string, Set<string>>, path: string): void {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    const here = path ? `${path} > ${name}` : name;
    if (name === PACKAGE && child.version) {
      const at = found.get(child.version) ?? new Set<string>();
      at.add(here);
      found.set(child.version, at);
    }
    collect(child, found, here);
  }
}

const raw = execFileSync('npm', ['ls', PACKAGE, '--all', '--json'], {
  encoding: 'utf8',
  // `npm ls` sai != 0 com peer deps insatisfeitas; o JSON vem mesmo assim.
  stdio: ['ignore', 'pipe', 'ignore'],
});

const found = new Map<string, Set<string>>();
collect(JSON.parse(raw) as LsOutput, found, '');

if (found.size === 0) {
  process.stderr.write(`✗ ${PACKAGE} não encontrado na árvore\n`);
  process.exit(1);
}

if (found.size === 1) {
  const [version] = [...found.keys()];
  process.stdout.write(`✓ uma cópia de ${PACKAGE} (${version})\n`);
  process.exit(0);
}

process.stderr.write(`✗ ${found.size} cópias de ${PACKAGE} na árvore:\n`);
for (const [version, paths] of found) {
  process.stderr.write(`  ${version}\n`);
  for (const path of paths) process.stderr.write(`    · ${path}\n`);
}
process.stderr.write(
  '\n  Alinhe a versão em package.json com a que o smart-account-kit exige\n' +
    '  e rode npm install. Duas cópias quebram a escrita de XDR com erros que\n' +
    '  não mencionam duplicação.\n',
);
process.exit(1);

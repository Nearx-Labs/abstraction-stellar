// Falha se houver mais de uma cópia de @stellar/stellar-sdk instalada.
//
// Não é frescura de bundle size. O `Spec` do contrato converte argumentos
// checando o construtor do valor: um ScVal criado por uma cópia do SDK não é
// reconhecido pelo `Spec` de outra cópia, e o erro que sai é
// "cannot interpret n3 value as ScVal" — com o nome minificado da classe, sem
// nenhuma pista de que o problema é versão duplicada.
//
// O smart-account-kit fixa a própria versão do SDK; a nossa precisa bater com
// ela para o npm hoistar uma cópia só.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const expected = JSON.parse(readFileSync(
  new URL('../node_modules/smart-account-kit/package.json', import.meta.url),
)).dependencies['@stellar/stellar-sdk'];

const ours = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  .dependencies['@stellar/stellar-sdk'];

let output = '';
try {
  output = execFileSync('npm', ['ls', '@stellar/stellar-sdk', '--all', '--json'], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
} catch (error) {
  // `npm ls` sai com código != 0 quando há dedupe pendente; a saída ainda serve.
  output = error.stdout ?? '';
}

// A árvore do `npm ls` indexa as dependências pelo NOME do pacote, então a
// versão só conta quando a chave é a que interessa — somar `child.version` de
// qualquer nó traz a versão do próprio kit junto.
const versions = new Set();
const walk = (node) => {
  if (!node || typeof node !== 'object') return;
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (name === '@stellar/stellar-sdk' && child?.version) versions.add(child.version);
    walk(child);
  }
};
walk(JSON.parse(output || '{}'));

if (versions.size > 1) {
  console.error(
    `@stellar/stellar-sdk duplicado: ${[...versions].join(', ')}\n` +
      `  o smart-account-kit fixa ${expected}; o package.json daqui pede ${ours}.\n` +
      `  Alinhe as duas para o npm hoistar uma cópia só, senão os ScVal que este\n` +
      `  app constrói são rejeitados pelo Spec do kit.`,
  );
  process.exit(1);
}

console.log(`@stellar/stellar-sdk: uma cópia (${[...versions][0] ?? ours})`);

// Confere e, quando possível, conserta a configuração on-chain do Treasury.
//
//   npm run bootstrap
//
// O que precisa estar de pé para o patrocínio funcionar ponta a ponta:
//   · o `operator` do Treasury é a conta que assina `consume`;
//   · o SAC do XLM está na allowlist de alvos;
//   · o Treasury tem orçamento;
//   · o `owner` do Treasury é a chave que este serviço usa para
//     `set_allowance` — sem isso o faucet ativa o XLM mas não a cota.
//
// Esse último ponto é a pegadinha: o Treasury implantado no testnet pertence à
// identidade `demo` do stellar CLI, não à chave deste serviço. E o contrato não
// tem `upgrade`, então não dá para adicionar um papel "provisioner" sem
// redeploy. O script não adivinha: ele diz exatamente o que fazer.
import { env } from '../src/env.js';
import { faucet, operator, owner } from '../src/chain/keys.js';
import {
  allowTarget,
  balance,
  getOperator,
  getOwner,
  isTargetAllowed,
  setOperator,
} from '../src/chain/treasury.js';
import { classicBalance } from '../src/chain/sac.js';
import { pool } from '../src/db/pool.js';

const treasuryId = env.TREASURY_CONTRACT_ID;
const problems: string[] = [];

function line(status: '✓' | '✗' | '·', text: string): void {
  process.stdout.write(`${status} ${text}\n`);
}

if (!treasuryId) {
  line('✗', 'TREASURY_CONTRACT_ID não configurado — o faucet não vai ativar cota nenhuma');
  process.exit(1);
}

process.stdout.write(`\nTreasury ${treasuryId}\n\n`);

const onchainOwner = await getOwner(treasuryId).catch(() => null);
const ownerMatches = onchainOwner === owner.publicKey();

if (ownerMatches) {
  line('✓', `owner confere (${owner.publicKey()})`);
} else {
  line('✗', `owner do contrato é ${onchainOwner ?? 'desconhecido'}`);
  line('·', `  a chave deste serviço é ${owner.publicKey()}`);
  problems.push(
    'set_allowance é #[only_owner]: sem a chave do owner o faucet envia XLM mas não ativa a cota.\n' +
      '  Duas saídas:\n' +
      `    a) apontar TREASURY_OWNER_SECRET para o secret do owner atual (${onchainOwner});\n` +
      '    b) transferir a posse para a chave do serviço:\n' +
      `       stellar contract invoke --id ${treasuryId} --source <owner> --network testnet \\\n` +
      `         -- transfer_ownership --new_owner ${owner.publicKey()}`,
  );
}

const onchainOperator = await getOperator(treasuryId).catch(() => null);
if (onchainOperator === operator.publicKey()) {
  line('✓', `operator confere (${operator.publicKey()})`);
} else if (ownerMatches) {
  await setOperator(owner, treasuryId, operator.publicKey());
  line('✓', `operator atualizado para ${operator.publicKey()}`);
} else {
  line('✗', `operator do contrato é ${onchainOperator ?? 'desconhecido'}`);
  problems.push(
    'Treasury.consume exige o operator. Ajuste com:\n' +
      `    stellar contract invoke --id ${treasuryId} --source <owner> --network testnet \\\n` +
      `      -- set_operator --operator ${operator.publicKey()}`,
  );
}

const sacAllowed = await isTargetAllowed(treasuryId, env.XLM_SAC_ADDRESS).catch(() => false);
if (sacAllowed) {
  line('✓', `SAC do XLM está na allowlist (${env.XLM_SAC_ADDRESS})`);
} else if (ownerMatches) {
  await allowTarget(owner, treasuryId, env.XLM_SAC_ADDRESS, true);
  line('✓', 'SAC do XLM adicionado à allowlist');
} else {
  line('✗', 'SAC do XLM fora da allowlist do Treasury');
  problems.push(
    `    stellar contract invoke --id ${treasuryId} --source <owner> --network testnet \\\n` +
      `      -- allow_target --target ${env.XLM_SAC_ADDRESS} --allowed true`,
  );
}

const budget = await balance(treasuryId).catch(() => 0n);
if (budget > 0n) {
  line('✓', `orçamento do Treasury: ${budget} stroops`);
} else {
  line('✗', 'Treasury sem orçamento — os débitos de consume vão falhar');
  problems.push(
    `    stellar contract invoke --id ${treasuryId} --source <owner> --network testnet \\\n` +
      '      -- deposit --from <owner> --amount 1000000000',
  );
}

const faucetBalance = await classicBalance(faucet.publicKey()).catch(() => 0n);
if (faucetBalance >= env.FAUCET_MIN_BALANCE_STROOPS) {
  line('✓', `conta de faucet com ${faucetBalance} stroops (${faucet.publicKey()})`);
} else {
  line('✗', `conta de faucet com saldo baixo: ${faucetBalance} stroops`);
  problems.push(`    curl "${env.FRIENDBOT_URL}?addr=${faucet.publicKey()}"`);
}

if (problems.length > 0) {
  process.stdout.write(`\n${problems.length} pendência(s):\n\n`);
  for (const problem of problems) process.stdout.write(`${problem}\n\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nTudo pronto.\n');
}

await pool.end();

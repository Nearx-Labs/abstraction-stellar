// Configuração da rede e dos contratos.
//
// Diferença do client antigo: nada mais é constante compilada. Tudo sai de
// VITE_*, com os deploys de testnet deste repositório como fallback — trocar de
// ambiente passa a ser variável de build, não edição de código.
const fromEnv = (key: string, fallback: string): string =>
  (import.meta.env[key] as string | undefined)?.trim() || fallback;

export const API_URL = fromEnv('VITE_API_URL', 'http://localhost:8080').replace(/\/+$/, '');

/** Chave pública do app. Vai no PATH do relayer — o kit não manda headers. */
export const PUBLISHABLE_KEY = fromEnv('VITE_PUBLISHABLE_KEY', 'pk_test_dev');

export const CONFIG = {
  rpcUrl: fromEnv('VITE_RPC_URL', 'https://soroban-testnet.stellar.org'),
  networkPassphrase: fromEnv('VITE_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015'),

  accountWasmHash: fromEnv(
    'VITE_ACCOUNT_WASM_HASH',
    '750df2a268be9743d390ef65a496d9013df5c66127212be70cb856c55b426daa',
  ),
  webauthnVerifierAddress: fromEnv(
    'VITE_WEBAUTHN_VERIFIER',
    'CBQGQXWD6GSCPMP32JRPRPXPNHEN7PWEUI6LXOQZ2HWODO6ZAXRG3SPI',
  ),
  ed25519VerifierAddress: fromEnv(
    'VITE_ED25519_VERIFIER',
    'CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ',
  ),
  emailVerifierAddress: fromEnv(
    'VITE_EMAIL_VERIFIER',
    'CDW2NDHXXVZB7PMIIBISBBJKBX6AM77CXX5TVH66PUGERZM5JPCDJWKM',
  ),
  spendingLimitPolicyAddress: fromEnv(
    'VITE_SPENDING_LIMIT_POLICY',
    'CC3GRDE3QDLXFOZJMC6SNZHRKWGQXELANBJWS6T3H7GO77K4NRKFUIDT',
  ),
  treasuryContractId: fromEnv(
    'VITE_TREASURY',
    'CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV',
  ),
  xlmSacAddress: fromEnv(
    'VITE_XLM_SAC',
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  ),

  /** Ledger de POC: mint com campos livres (contracts/demo-ledger). */
  demoLedgerAddress: fromEnv(
    'VITE_DEMO_LEDGER',
    'CDIUO6EQ5DE6W3BYTF5YT2DDXMMZ4IEM4NKURDQT5WTBOXZASBWZTR6R',
  ),
  /** Policy que limita QUANTOS mints uma regra pode fazer (contracts/mint-quota-policy). */
  mintQuotaPolicyAddress: fromEnv(
    'VITE_MINT_QUOTA_POLICY',
    'CDFOWCHLFZVD64CZ2PNAE6HVUT2UM33323D3ZPCZXMQ4AE4WN4UANVPV',
  ),

  /** O kit posta aqui; a publishable key identifica o app pelo path. */
  relayerUrl: `${API_URL}/v1/relay/${PUBLISHABLE_KEY}`,
} as const;

export const APP_NAME = 'Abstraction';

export const EXPLORER = fromEnv(
  'VITE_EXPLORER',
  'https://stellar.expert/explorer/testnet',
);

export const contractUrl = (address: string) => `${EXPLORER}/contract/${address}`;
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;

export const DEPLOYED_CONTRACTS: Array<[string, string]> = [
  ['Treasury (paymaster)', CONFIG.treasuryContractId],
  ['WebAuthn verifier (passkeys)', CONFIG.webauthnVerifierAddress],
  ['Ed25519 verifier (session keys)', CONFIG.ed25519VerifierAddress],
  ['Email attestation verifier', CONFIG.emailVerifierAddress],
  ['Spending-limit policy', CONFIG.spendingLimitPolicyAddress],
  ['Mint-quota policy', CONFIG.mintQuotaPolicyAddress],
  ['Demo ledger (mint)', CONFIG.demoLedgerAddress],
];

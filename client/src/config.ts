// Deploys oficiais do smart-account-kit no testnet (Protocol 27, 2026-07-09):
// https://github.com/kalepail/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md
//
// Para usar o WASM próprio deste repositório em vez do oficial:
//   stellar contract build
//   stellar contract upload --wasm target/wasm32v1-none/release/meta_account.wasm \
//     --source <identity> --network testnet
// e substitua ACCOUNT_WASM_HASH pelo hash retornado. O construtor do
// meta-account é compatível com o esperado pelo kit: (signers, policies).
export const TESTNET_CONFIG = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  // Contratos DESTE repositório implantados no testnet (2026-07-15).
  // Oficiais do kit (fallback): wasm 1b5f4534…, CC7EKIHQ…, CAAVTMCB….
  accountWasmHash: '750df2a268be9743d390ef65a496d9013df5c66127212be70cb856c55b426daa',
  webauthnVerifierAddress: 'CBQGQXWD6GSCPMP32JRPRPXPNHEN7PWEUI6LXOQZ2HWODO6ZAXRG3SPI',
  ed25519VerifierAddress: 'CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ',
  // Fase 3 — transações patrocinadas via services/relayer-proxy (policy de
  // quota/allowlist na frente da submissão). Rode `npm run dev` no proxy e o
  // kit passa a usar este endpoint para tudo (usuário não paga fee). Em
  // produção, o proxy encaminha para o OZ Channels
  // (https://channels.openzeppelin.com/testnet) via CHANNELS_URL/API_KEY.
  relayerUrl: 'http://localhost:8787' as string | undefined,

  // Fase 2 — email attestation. Faça o deploy do verificador deste repo:
  //   stellar contract build
  //   stellar contract deploy \
  //     --wasm target/wasm32v1-none/release/email_attestation_verifier.wasm \
  //     --source <identity> --network testnet
  // e cole o C-address aqui. O serviço emissor roda em services/auth-issuer.
  emailVerifierAddress: 'CDW2NDHXXVZB7PMIIBISBBJKBX6AM77CXX5TVH66PUGERZM5JPCDJWKM',
  authIssuerUrl: 'http://localhost:8788',

  // Fase 4 — session keys (spending-limit policy deste repo).
  spendingLimitPolicyAddress: 'CC3GRDE3QDLXFOZJMC6SNZHRKWGQXELANBJWS6T3H7GO77K4NRKFUIDT',

  // Fase 3 — treasury deste repo (owner: demo, operator: relayer).
  treasuryContractId: 'CDKC5JHDED55KNI7U7AEJMZN6NLOYIASUWXPAV2QE74SMZ4VEFM7NKOV',
  // XLM SAC no testnet (token do treasury e alvo patrocinável do demo).
  xlmSacAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
};

export const APP_NAME = 'Abstraction';

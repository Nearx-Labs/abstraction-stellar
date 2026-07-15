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
  accountWasmHash: '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a',
  webauthnVerifierAddress: 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F',
  ed25519VerifierAddress: 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4',
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
  emailVerifierAddress: 'CEMAIL_VERIFIER_NOT_DEPLOYED_YET',
  authIssuerUrl: 'http://localhost:8788',
};

export const APP_NAME = 'Abstraction';

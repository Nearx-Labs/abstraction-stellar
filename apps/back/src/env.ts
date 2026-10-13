// Configuração do processo, validada no boot.
//
// A regra aqui é falhar rápido. Os dois serviços antigos tinham defaults
// perigosos que só emitiam warning: sem FEE_PAYER_SECRET o relayer criava uma
// conta efêmera no friendbot a cada restart (quebrando o operator do Treasury),
// e sem ISSUER_SEED_HEX o auth-issuer assinava attestations com
// Buffer.alloc(32, 42) — a mesma chave do fixture de teste, pública no repo.
// Fora de desenvolvimento, ambos agora impedem o processo de subir.
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const bigintish = (def: bigint) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : BigInt(v)));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Configuração de rede e de contrato sem default aceitável fora de dev. */
const EXPLICIT_OUTSIDE_DEV = [
  'RPC_URL',
  'NETWORK_PASSPHRASE',
  'PUBLIC_URL',
  'RP_ID',
  'DEMO_LEDGER_CONTRACT_ID',
  'ANCHOR_CONTRACT_ID',
  'ACCOUNT_WASM_HASH',
  'ED25519_VERIFIER_ADDRESS',
  'MINT_QUOTA_POLICY_ADDRESS',
  'XLM_SAC_ADDRESS',
] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

    // Rede
    RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
    NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
    FRIENDBOT_URL: z.string().url().default('https://friendbot.stellar.org'),
    /** URL pública do próprio serviço — entra nas URIs de mídia gravadas no contrato. */
    PUBLIC_URL: z.string().url().default('http://localhost:8080'),

    // Contratos
    TREASURY_CONTRACT_ID: z.string().optional(),
    // Contrato de POC do mint com campos livres (contracts/demo-ledger).
    DEMO_LEDGER_CONTRACT_ID: z
      .string()
      .default('CCBGDWXPHXPGYJL2T4GDIF6PAGZ3XVYFR67HBFQ5RVJXGNMT5KGCUD5G'),
    // Contrato de âncora de eventos de negócio (contracts/anchor-ledger).
    // Alvo separado do demo-ledger de propósito: o inventário e o histórico
    // contábil têm cotas independentes, cada um com seu grant.
    ANCHOR_CONTRACT_ID: z
      .string()
      .default('CAJLZT55SAI5U23QK3EBGBKHIJSOASKACLVRTTVAK6WHVOUYYGLO3YTA'),
    /**
     * Wasm da smart account, para o serviço provisionar a conta mestre de um
     * tenant sem browser. Mesmo hash que o painel usa.
     */
    ACCOUNT_WASM_HASH: z
      .string()
      .default('750df2a268be9743d390ef65a496d9013df5c66127212be70cb856c55b426daa'),
    ED25519_VERIFIER_ADDRESS: z
      .string()
      .default('CCNJDEL774D5UIOEYXIJZRY3HVVR4FIKGGURY34TFCWPAC25QYNRUKMJ'),
    /**
     * Semente da chave Ed25519 que o serviço usa para assinar como conta
     * mestre. A chave por app é derivada daqui — nada de segredo em repouso no
     * banco. Trocar isto invalida os grants já concedidos on-chain.
     */
    MASTER_SIGNER_SEED: z.string().default('abstraction-dev-master-seed'),
    MINT_QUOTA_POLICY_ADDRESS: z
      .string()
      .default('CCKCKDXEWD3LHSZT3OLTJTRFNMXPQPONKUPQPQJ2CAXFVNACJDFAYWVJ'),
    XLM_SAC_ADDRESS: z
      .string()
      .default('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),

    // Chaves por papel. channel* pagam as txs dos usuários; operator assina
    // Treasury.consume; owner assina set_allowance/allow_target (only_owner);
    // faucet envia XLM. Ver fee_payer_channels.role.
    CHANNEL_SECRETS: csv,
    TREASURY_OPERATOR_SECRET: z.string().optional(),
    TREASURY_OWNER_SECRET: z.string().optional(),
    FAUCET_SECRET: z.string().optional(),

    // Faucet
    FAUCET_AMOUNT_STROOPS: bigintish(100_000_000n), // 10 XLM
    FAUCET_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
    FAUCET_MIN_BALANCE_STROOPS: bigintish(500_000_000n), // 50 XLM → FAUCET_DRY
    // Calibrado pelo custo real observado no testnet, não por chute: criar uma
    // context rule com policy instalada e assinatura WebAuthn custa ~1,02 XLM
    // (a assinatura é grande e a instalação escreve estado). Um teto de 0,5 XLM
    // recusava a operação mais comum do produto, e um teto DIÁRIO de 2 XLM dava
    // duas criações de regra por dia.
    ALLOWANCE_MAX_PER_TX: bigintish(30_000_000n), // 3 XLM
    ALLOWANCE_MAX_PER_DAY: bigintish(200_000_000n), // 20 XLM
    ALLOWANCE_TTL_DAYS: z.coerce.number().int().positive().default(365),

    // WebAuthn (sessão do painel)
    RP_ID: z.string().default('localhost'),
    RP_ORIGINS: csv,
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

    // Email issuer
    ISSUER_SEED_HEX: z.string().optional(),
    SUBJECT_SALT: z.string().default('abstraction-dev-salt'),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    EMAIL_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    ATTESTATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),

    // Superfície exposta. Fora de development, cada uma começa DESLIGADA e o
    // ambiente liga o que usa: o MintVRS opera só com secret key, e cada uma
    // destas é uma porta que gasta XLM do sponsor ou mexe em conta alheia.
    /** Relay patrocinado (`POST /v1/relay/:pk`), o caminho do smart-account-kit. */
    RELAY_ENABLED: z.string().optional(),
    /** Faucet de XLM. Nunca liga fora da testnet, qualquer que seja o valor. */
    FAUCET_ENABLED: z.string().optional(),
    /** `POST /v1/accounts` com publishable key (registro pelo browser). */
    ACCOUNT_SELF_REGISTRATION: z.string().optional(),
    /**
     * Sessão de painel pode nomear a conta mestre e registrar grant quando o app
     * ainda não tem mestre (fluxo de auto-custódia com passkey). Com mestre já
     * definida, só a sessão DA PRÓPRIA mestre mexe nela.
     */
    PANEL_MASTER_ADMIN: z.string().optional(),
    /** Deploy de conta patrocinado pelo relay. */
    BOOTSTRAP_ALLOW_DEPLOY: z.string().optional(),

    /**
     * Teto de fee de uma transação assinada pela conta mestre, em stroops. Sem
     * teto, uma restauração de estado arquivado (ou um bug) sai paga por
     * qualquer valor que a simulação devolva.
     */
    MASTER_MAX_FEE_STROOPS: bigintish(50_000_000n), // 5 XLM
    /** Quanto as rotas da conta mestre esperam por um channel livre. */
    CHANNEL_WAIT_MS: z.coerce.number().int().nonnegative().default(20_000),
    /**
     * Quanto uma escrita espera a vez no contrato (uma por vez, ver
     * db/queries/contractLock.ts). ~5s por escrita: 50s comportam ~10 na fila.
     */
    CONTRACT_LOCK_WAIT_MS: z.coerce.number().int().nonnegative().default(50_000),

    // Encaminhamento opcional pro OpenZeppelin Channels
    CHANNELS_URL: z.string().url().optional(),
    CHANNELS_API_KEY: z.string().optional(),

    // Bootstrap do app pelo ambiente. A imagem de produção não tem npm, então
    // sem isto registrar um app exigiria SQL na mão no banco gerenciado.
    BOOTSTRAP_APP_SLUG: z.string().optional(),
    BOOTSTRAP_APP_NAME: z.string().optional(),
    BOOTSTRAP_SECRET_KEY: z.string().optional(),
    BOOTSTRAP_PUBLISHABLE_KEY: z.string().optional(),
    BOOTSTRAP_NETWORK: z.string().default('testnet'),
    BOOTSTRAP_ORIGINS: csv,
    // Login do painel pelo ambiente, mesma razão do app: sem isto, criar o
    // primeiro acesso num ambiente publicado exigiria psql no banco gerenciado.
    BOOTSTRAP_PANEL_EMAIL: z.string().optional(),
    BOOTSTRAP_PANEL_PASSWORD: z.string().optional(),

    RUN_WORKERS: bool(true),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'development') return;

    const required: Array<[string, unknown]> = [
      ['CHANNEL_SECRETS', v.CHANNEL_SECRETS.length > 0 ? v.CHANNEL_SECRETS : undefined],
      ['TREASURY_OPERATOR_SECRET', v.TREASURY_OPERATOR_SECRET],
      ['TREASURY_OWNER_SECRET', v.TREASURY_OWNER_SECRET],
      ['TREASURY_CONTRACT_ID', v.TREASURY_CONTRACT_ID],
      ['ISSUER_SEED_HEX', v.ISSUER_SEED_HEX],
      ['RP_ORIGINS', v.RP_ORIGINS.length > 0 ? v.RP_ORIGINS : undefined],
    ];
    if (truthy(v.FAUCET_ENABLED) && !v.FAUCET_SECRET) {
      required.push(['FAUCET_SECRET', undefined]);
    }
    // Os defaults de rede e de contrato são os deploys de TESTNET deste repo.
    // Em development servem; fora dele, um default silencioso foi como dois
    // ambientes acabaram gravando nos mesmos contratos — e seria como uma
    // instância de mainnet subiria apontando para endereços que não existem lá.
    for (const key of EXPLICIT_OUTSIDE_DEV) {
      if (!process.env[key]?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} precisa ser explícito fora de NODE_ENV=development (o default é de testnet)`,
        });
      }
    }
    if (v.MASTER_SIGNER_SEED === 'abstraction-dev-master-seed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MASTER_SIGNER_SEED'],
        message:
          'MASTER_SIGNER_SEED está no valor de desenvolvimento. Quem souber deste ' +
          'valor assina como a conta mestre de qualquer tenant, até o teto concedido.',
      });
    }
    for (const [key, value] of required) {
      if (value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} é obrigatório fora de NODE_ENV=development`,
        });
      }
    }
    if (v.SUBJECT_SALT === 'abstraction-dev-salt') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUBJECT_SALT'],
        message:
          'SUBJECT_SALT está no valor de desenvolvimento. Trocar o salt depois ' +
          'invalida TODO email signer já registrado on-chain (o subject_hash muda).',
      });
    }
  });

export type Env = z.infer<typeof schema>;

function truthy(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuração inválida:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export const env = load();
export const isDev = env.NODE_ENV === 'development';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const isTestnet = env.NETWORK_PASSPHRASE === TESTNET_PASSPHRASE;

/** Flag de superfície: explícita no env, ou ligada por padrão só em development. */
function flag(value: string | undefined): boolean {
  return value === undefined ? isDev : truthy(value);
}

export const features = {
  relay: flag(env.RELAY_ENABLED),
  /** Testnet sempre exigida: faucet na mainnet distribui XLM de verdade. */
  faucet: flag(env.FAUCET_ENABLED) && isTestnet,
  accountSelfRegistration: flag(env.ACCOUNT_SELF_REGISTRATION),
  panelMasterAdmin: flag(env.PANEL_MASTER_ADMIN),
  allowDeploy: flag(env.BOOTSTRAP_ALLOW_DEPLOY),
} as const;

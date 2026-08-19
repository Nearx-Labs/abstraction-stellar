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

    // Encaminhamento opcional pro OpenZeppelin Channels
    CHANNELS_URL: z.string().url().optional(),
    CHANNELS_API_KEY: z.string().optional(),

    RUN_WORKERS: bool(true),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'development') return;

    const required: Array<[string, unknown]> = [
      ['CHANNEL_SECRETS', v.CHANNEL_SECRETS.length > 0 ? v.CHANNEL_SECRETS : undefined],
      ['TREASURY_OPERATOR_SECRET', v.TREASURY_OPERATOR_SECRET],
      ['TREASURY_OWNER_SECRET', v.TREASURY_OWNER_SECRET],
      ['FAUCET_SECRET', v.FAUCET_SECRET],
      ['TREASURY_CONTRACT_ID', v.TREASURY_CONTRACT_ID],
      ['ISSUER_SEED_HEX', v.ISSUER_SEED_HEX],
      ['RP_ORIGINS', v.RP_ORIGINS.length > 0 ? v.RP_ORIGINS : undefined],
    ];
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

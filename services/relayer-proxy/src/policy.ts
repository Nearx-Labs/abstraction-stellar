// Camada de policy off-chain do paymaster (enforcement operacional).
//
// Complementa a policy declarativa on-chain do contrato Treasury: aqui ficam
// as decisões que precisam de simulação de custo e estado quente — allowlist
// de contratos-alvo, teto de fee por transação e quota diária por smart
// account. O débito auditável correspondente é feito on-chain via
// Treasury.consume (ver stellar.ts).
export interface PolicyConfig {
  /** C-addresses patrocináveis; vazio = qualquer alvo (apenas dev). */
  targetAllowlist: Set<string>;
  /** Teto de fee patrocinada por transação, em stroops. */
  maxFeePerTx: bigint;
  /** Teto de fee patrocinada por conta por dia, em stroops. */
  maxFeePerDay: bigint;
}

export function loadPolicy(): PolicyConfig {
  const allowlist = (process.env.TARGET_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    targetAllowlist: new Set(allowlist),
    maxFeePerTx: BigInt(process.env.MAX_FEE_PER_TX ?? 5_000_000), // 0.5 XLM
    maxFeePerDay: BigInt(process.env.MAX_FEE_PER_DAY ?? 20_000_000), // 2 XLM
  };
}

export class PolicyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

const usage = new Map<string, { day: number; spent: bigint }>();

function today(): number {
  return Math.floor(Date.now() / 1000 / 86_400);
}

export function spentToday(user: string): bigint {
  const entry = usage.get(user);
  return entry && entry.day === today() ? entry.spent : 0n;
}

/**
 * Valida a transação contra a policy. Lança PolicyError se violar.
 * `targets` são os contratos invocados; `user` é a smart account (das auth
 * entries); `fee` é o custo total simulado em stroops.
 */
export function enforcePolicy(
  policy: PolicyConfig,
  targets: string[],
  user: string | undefined,
  fee: bigint,
): void {
  if (policy.targetAllowlist.size > 0) {
    for (const target of targets) {
      if (!policy.targetAllowlist.has(target)) {
        throw new PolicyError(`alvo ${target} não é patrocinável`, 'UNAUTHORIZED');
      }
    }
  }
  if (fee > policy.maxFeePerTx) {
    throw new PolicyError(
      `fee ${fee} excede o teto por transação (${policy.maxFeePerTx})`,
      'FEE_LIMIT_EXCEEDED',
    );
  }
  if (user) {
    const spent = spentToday(user);
    if (spent + fee > policy.maxFeePerDay) {
      throw new PolicyError(
        `quota diária de ${user} excedida (${spent} + ${fee} > ${policy.maxFeePerDay})`,
        'FEE_LIMIT_EXCEEDED',
      );
    }
  }
}

/** Registra o consumo após submissão bem-sucedida. */
export function recordSpend(user: string | undefined, fee: bigint): void {
  if (!user) return;
  const d = today();
  const entry = usage.get(user);
  if (!entry || entry.day !== d) {
    usage.set(user, { day: d, spent: fee });
  } else {
    entry.spent += fee;
  }
}

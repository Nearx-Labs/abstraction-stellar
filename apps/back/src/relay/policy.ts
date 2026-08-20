// Policy off-chain do paymaster — decisões que precisam de simulação de custo.
//
// Complementa a policy declarativa do contrato Treasury. Aqui a função é pura:
// recebe policy + intenção + custo e decide. A quota diária saiu daqui e virou
// reserva atômica no Postgres (db/queries/quota.ts), porque um Map em memória
// não sobrevive a restart nem a mais de uma réplica.
import type { SponsorshipPolicy } from '../db/queries/apps.js';
import type { ParsedIntent } from '../chain/parse.js';

export class PolicyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export function enforcePolicy(
  policy: SponsorshipPolicy,
  intent: ParsedIntent,
  feeCap: bigint,
): void {
  if (intent.isDeploy) {
    if (!policy.allowDeploy) {
      throw new PolicyError('este app não patrocina criação de contas', 'DEPLOY_NOT_ALLOWED');
    }
    if (feeCap > policy.deployFeeCap) {
      throw new PolicyError(
        `fee de deploy ${feeCap} excede o teto (${policy.deployFeeCap})`,
        'FEE_LIMIT_EXCEEDED',
      );
    }
    return;
  }

  // Allowlist vazia costumava significar "patrocina qualquer contrato", com
  // apenas um console.warn no boot. Agora é erro de configuração.
  if (policy.targetAllowlist.size === 0) {
    throw new PolicyError(
      'nenhum contrato-alvo configurado para patrocínio neste app',
      'ALLOWLIST_EMPTY',
    );
  }

  for (const target of intent.targets) {
    // A smart account invocando a si mesma (admin, rules, recovery) é sempre
    // patrocinável — quem limita isso é a allowance por usuário. A allowlist
    // existe para contratos externos.
    if (target === intent.user) continue;
    if (!policy.targetAllowlist.has(target)) {
      throw new PolicyError(`alvo ${target} não é patrocinável`, 'UNAUTHORIZED');
    }
  }

  if (feeCap > policy.maxFeePerTx) {
    throw new PolicyError(
      `fee ${feeCap} excede o teto por transação (${policy.maxFeePerTx})`,
      'FEE_LIMIT_EXCEEDED',
    );
  }
}

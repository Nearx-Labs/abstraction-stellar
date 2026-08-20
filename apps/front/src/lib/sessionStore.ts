// Guarda local das chaves de sessão.
//
// Antes a chave era `Keypair.random()` numa variável: recarregar a página a
// perdia, e a regra ficava viva on-chain sem ninguém para usá-la. Isso obrigava
// a permissão a ter prazo curto — se ela nunca expirasse, o acúmulo de regras
// órfãs seria permanente.
//
// Persistir a chave é o que torna coerente uma permissão sem prazo: ela
// continua utilizável entre sessões do browser, e quem a encerra é a revogação,
// não um relógio.
//
// O risco assumido: uma chave assinante em localStorage é legível por XSS. O
// que limita o estrago é o mesmo que limita o de qualquer grant: ela fala com
// UM contrato, tem teto de gasto por janela e é revogável a qualquer momento.
// É exatamente a troca que um grant de dApp faz — e por isso a chave nunca
// entra na regra Default, que administraria a conta.
const PREFIX = 'abstraction.session.';

export interface StoredSession {
  ruleId: number;
  secret: string;
  publicKey: string;
  name: string;
  targetContract: string;
  /**
   * Policy instalada na regra.
   *
   * Guardado porque a policy errada torna o grant inútil sem que nada aqui
   * perceba: uma regra de contrato não-token com a spending-limit instalada
   * recusa toda chamada com NotAllowed (3223). Comparar isto é o que permite
   * descartar um grant assim e refazê-lo.
   */
  policyAddress?: string;
  createdAt: number;
}

const keyOf = (smartAccount: string, ruleId: number) =>
  `${PREFIX}${smartAccount}.${ruleId}`;

export function save(smartAccount: string, session: StoredSession): void {
  try {
    localStorage.setItem(keyOf(smartAccount, session.ruleId), JSON.stringify(session));
  } catch {
    // Modo privado ou storage cheio: a sessão segue valendo nesta aba.
  }
}

export function load(smartAccount: string, ruleId: number): StoredSession | null {
  try {
    const raw = localStorage.getItem(keyOf(smartAccount, ruleId));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function remove(smartAccount: string, ruleId: number): void {
  try {
    localStorage.removeItem(keyOf(smartAccount, ruleId));
  } catch {
    // nada a fazer
  }
}

/** Todas as chaves guardadas desta conta. */
export function all(smartAccount: string): StoredSession[] {
  const out: StoredSession[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(`${PREFIX}${smartAccount}.`)) continue;
      const raw = localStorage.getItem(key);
      if (raw) out.push(JSON.parse(raw) as StoredSession);
    }
  } catch {
    // storage indisponível
  }
  return out;
}

/** Remove chaves de regras que não existem mais on-chain. */
export function prune(smartAccount: string, liveRuleIds: Set<number>): void {
  for (const session of all(smartAccount)) {
    if (!liveRuleIds.has(session.ruleId)) remove(smartAccount, session.ruleId);
  }
}

// Concessão de permissão ao serviço.
//
// O tenant, com a passkey, cria uma context rule `CallContract(alvo)` que
// autoriza a chave Ed25519 do serviço e instala a mint-quota-policy com o teto.
// Depois disso a API opera sozinha — mas só naquele contrato e só até o número
// autorizado.
//
// São DOIS alvos, com cotas independentes:
//   · `ledger` — o inventário de itens (demo-ledger), onde a chave comprada é
//     mintada;
//   · `anchor` — o histórico contábil (anchor-ledger), onde entram crédito,
//     reembolso e split, que não são itens.
//
// Separados porque a mint-quota-policy cobra 1 unidade de qualquer função que
// não seja `mint_batch`: no mesmo grant, cada reembolso comeria uma chave da
// cota do inventário, e o número que o tenant autorizou deixaria de significar
// o que ele pensa que significa.
//
// O serviço não pode se conceder poder: quem assina esta transação é o dono da
// conta.
import {
  createCallContractContext,
  createEd25519Signer,
  type SmartAccountKit,
} from 'smart-account-kit';
import { api } from './api';
import { mintQuotaParams } from './policyParams';
import { findRuleForSigner, nextContextRuleId, signAndSubmit } from './submit';

/** Os dois contratos que a conta mestre pode autorizar. */
export type GrantTarget = 'ledger' | 'anchor';

export interface Grant {
  contextRuleId: number | null;
  maxItems: number;
  periodLedgers: number;
  state: 'pending' | 'active' | 'revoked';
  grantTxHash: string | null;
}

export interface Quota {
  maxItems: number;
  used: number;
  remaining: number;
  windowResetsAtLedger: number;
}

export interface TargetState {
  contract: string;
  grant: Grant | null;
  quota: Quota | null;
}

export interface MasterState {
  masterAccount: string | null;
  signer: { publicKeyHex: string; verifier: string };
  ledgerContract: string;
  anchorContract: string;
  policyContract: string;
  /** Atalho para `targets.ledger.grant`; mantido pelo back por compatibilidade. */
  grant: Grant | null;
  quota: Quota | null;
  targets: Record<GrantTarget, TargetState>;
}

export const masterApi = {
  state: () => api.get<MasterState>('/v1/master'),
  setAccount: (contractId: string) => api.post<MasterState>('/v1/master', { contractId }),
  recordGrant: (body: {
    contextRuleId: number | null;
    maxItems: number;
    periodLedgers: number;
    grantTxHash?: string;
    target: GrantTarget;
  }) => api.post<{ id: string; state: string }>('/v1/master/grant', body),
  revokeGrant: (target: GrantTarget) =>
    api.delete<{ success: true }>(`/v1/master/grant?target=${target}`),

  /**
   * Provisiona a conta e as duas permissões pelo serviço.
   *
   * É o caminho da conta custodial: nada é assinado no browser, porque o
   * browser não tem chave nenhuma dela.
   */
  provision: (body: { ledgerMaxItems?: number; anchorMaxItems?: number; periodLedgers?: number }) =>
    api.post<{
      masterAccount: string;
      deployHash: string | null;
      granted: Array<{ target: GrantTarget; contextRuleId: number | null; hash: string }>;
    }>('/v1/master/provision', body),
};

export interface GrantResult {
  contextRuleId: number | null;
  txHash?: string;
}

const RULE_NAME: Record<GrantTarget, string> = {
  ledger: 'mint do serviço',
  anchor: 'âncora do serviço',
};

/**
 * Cria a regra que autoriza o serviço num alvo. Um toque na passkey.
 *
 * `valid_until` fica aberto de propósito: o teto aqui é de quantidade, não de
 * prazo — o tenant revoga quando quiser, e a policy segura o volume enquanto
 * isso não acontece.
 */
export async function grantPermission(
  kit: SmartAccountKit,
  state: MasterState,
  target: GrantTarget,
  maxItems: number,
  periodLedgers: number,
): Promise<GrantResult> {
  const contract = state.targets[target].contract;

  const signer = createEd25519Signer(
    state.signer.verifier,
    Buffer.from(state.signer.publicKeyHex, 'hex'),
  );

  const policies = new Map<string, unknown>([
    [state.policyContract, mintQuotaParams(maxItems, periodLedgers)],
  ]);

  const expectedRuleId = await nextContextRuleId(kit);

  const tx = await kit.rules.add(
    createCallContractContext(contract),
    RULE_NAME[target],
    [signer],
    policies,
  );
  const result = await signAndSubmit(kit, tx);

  const grant: GrantResult = {
    contextRuleId: await findRuleForSigner(
      kit,
      state.signer.publicKeyHex,
      expectedRuleId,
      contract,
    ),
    txHash: result.hash,
  };

  await masterApi.recordGrant({
    contextRuleId: grant.contextRuleId,
    maxItems,
    periodLedgers,
    grantTxHash: grant.txHash,
    target,
  });

  return grant;
}

/** Revoga a permissão de um alvo, on-chain e no registro. */
export async function revokePermission(
  kit: SmartAccountKit,
  target: GrantTarget,
  contextRuleId: number,
): Promise<void> {
  const tx = await kit.rules.remove(contextRuleId);
  await signAndSubmit(kit, tx);
  await masterApi.revokeGrant(target);
}

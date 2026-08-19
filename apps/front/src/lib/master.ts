// Concessão da permissão de mint ao serviço.
//
// O tenant, com a passkey, cria uma context rule `CallContract(demo-ledger)`
// que autoriza a chave Ed25519 do serviço e instala a mint-quota-policy com o
// teto de itens. Depois disso a API minta sozinha — mas só naquele contrato e
// só até o número autorizado.
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

export interface MasterState {
  masterAccount: string | null;
  signer: { publicKeyHex: string; verifier: string };
  ledgerContract: string;
  policyContract: string;
  grant: {
    contextRuleId: number | null;
    maxItems: number;
    periodLedgers: number;
    state: 'pending' | 'active' | 'revoked';
    grantTxHash: string | null;
  } | null;
  quota: {
    maxItems: number;
    used: number;
    remaining: number;
    windowResetsAtLedger: number;
  } | null;
}

export const masterApi = {
  state: () => api.get<MasterState>('/v1/master'),
  setAccount: (contractId: string) => api.post<MasterState>('/v1/master', { contractId }),
  recordGrant: (body: {
    contextRuleId: number | null;
    maxItems: number;
    periodLedgers: number;
    grantTxHash?: string;
  }) => api.post<{ id: string; state: string }>('/v1/master/grant', body),
  revokeGrant: () => api.delete<{ success: true }>('/v1/master/grant'),
};

export interface GrantResult {
  contextRuleId: number | null;
  txHash?: string;
}

/**
 * Cria a regra que autoriza o serviço. Um toque na passkey.
 *
 * `valid_until` fica aberto de propósito: o teto aqui é de quantidade, não de
 * prazo — o tenant revoga quando quiser, e a policy segura o volume enquanto
 * isso não acontece.
 */
export async function grantMintPermission(
  kit: SmartAccountKit,
  state: MasterState,
  maxItems: number,
  periodLedgers: number,
): Promise<GrantResult> {
  const signer = createEd25519Signer(
    state.signer.verifier,
    Buffer.from(state.signer.publicKeyHex, 'hex'),
  );

  const policies = new Map<string, unknown>([
    [state.policyContract, mintQuotaParams(maxItems, periodLedgers)],
  ]);

  const name = 'mint do serviço';
  const expectedRuleId = await nextContextRuleId(kit);

  const tx = await kit.rules.add(
    createCallContractContext(state.ledgerContract),
    name,
    [signer],
    policies,
  );
  const result = await signAndSubmit(kit, tx);

  const grant: GrantResult = {
    contextRuleId: await findRuleForSigner(
      kit,
      state.signer.publicKeyHex,
      expectedRuleId,
      state.ledgerContract,
    ),
    txHash: result.hash,
  };

  await masterApi.recordGrant({
    contextRuleId: grant.contextRuleId,
    maxItems,
    periodLedgers,
    grantTxHash: grant.txHash,
  });

  return grant;
}

/** Revoga a permissão on-chain e no registro. */
export async function revokeMintPermission(
  kit: SmartAccountKit,
  contextRuleId: number,
): Promise<void> {
  const tx = await kit.rules.remove(contextRuleId);
  await signAndSubmit(kit, tx);
  await masterApi.revokeGrant();
}

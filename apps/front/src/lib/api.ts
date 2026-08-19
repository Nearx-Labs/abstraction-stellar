// Cliente da API.
//
// `credentials: 'include'` em tudo: a sessão do painel é um cookie httpOnly, e
// o front roda numa origem diferente do back.
import { API_URL, PUBLISHABLE_KEY } from './config';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;

async function request<T>(
  path: string,
  init: RequestInit = {},
  attempt = 1,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch {
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
      return request<T>(path, init, attempt + 1);
    }
    throw new ApiError('Sem conexão com o servidor.', 'NETWORK', 0);
  }

  if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
    return request<T>(path, init, attempt + 1);
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new ApiError(
      (body.error as string) ?? 'Não deu certo agora.',
      (body.errorCode as string) ?? 'UNKNOWN',
      response.status,
      body,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Tipos de resposta ───────────────────────────────────────────────────────

export interface AccountResponse {
  account: {
    contractId: string;
    externalId: string | null;
    label: string | null;
    status: 'pending' | 'deployed' | 'failed';
    deployTxHash: string | null;
    createdAt: string;
  };
  balanceStroops: string | null;
  allowance: {
    maxPerTxStroops: string;
    maxPerDayStroops: string;
    expiresAt: number | null;
  } | null;
}

export interface UsageResponse {
  spentStroops: string;
  reservedStroops: string;
  maxPerDayStroops: string;
  maxPerTxStroops: string;
  txCount: number;
  resetsAt: string;
  onchain: { usageToday: string | null; hasAllowance: boolean };
}

export interface FaucetStatus {
  amountStroops: string;
  cooldownHours: number;
  blocked: boolean;
  nextAvailableAt: string | null;
  last: {
    state: 'pending' | 'xlm_sent' | 'allowance_set' | 'done' | 'failed';
    xlmTxHash: string | null;
    createdAt: string;
    error: string | null;
  } | null;
}

export interface FaucetClaimResponse {
  claimId: string;
  state: string;
  amountStroops: string;
  xlmTxHash: string | null;
  allowancePending: boolean;
  nextAvailableAt: string;
}

export interface SessionItem {
  id: string;
  contextRuleId: number | null;
  name: string;
  targetContract: string;
  publicKey: string;
  state: 'pending' | 'active' | 'expired' | 'revoked' | 'failed';
  spendingLimitStroops: string;
  spentStroops: string | null;
  remainingStroops: string | null;
  validUntilLedger: string;
  expiresInSeconds: number;
  grantTxHash: string | null;
  createdAt: string;
}

export const endpoints = {
  registerAccount: (body: {
    contractId: string;
    credentialId?: string;
    publicKeyHex?: string;
    label?: string;
    deployTxHash?: string;
  }) => api.post<{ success: true }>('/v1/accounts', { ...body, publishableKey: PUBLISHABLE_KEY }),

  challenge: (contractId: string) =>
    api.post<{ challenge: string; rpId: string; allowCredentials: Array<{ id: string }> }>(
      '/v1/authn/challenge',
      { contractId, publishableKey: PUBLISHABLE_KEY },
    ),

  verify: (body: Record<string, string>) =>
    api.post<{ success: true; contractId: string }>('/v1/authn/verify', body),

  logout: () => api.post<{ success: true }>('/v1/authn/logout'),

  account: (address: string) => api.get<AccountResponse>(`/v1/accounts/${address}`),
  usage: (address: string) => api.get<UsageResponse>(`/v1/accounts/${address}/usage`),

  faucetStatus: (address: string) => api.get<FaucetStatus>(`/v1/accounts/${address}/faucet`),
  claimFaucet: (address: string) =>
    api.post<FaucetClaimResponse>(`/v1/accounts/${address}/faucet`),
  retryAllowance: (address: string) =>
    api.post<{ queued: boolean }>(`/v1/accounts/${address}/faucet/allowance`),

  sessions: (address: string) =>
    api.get<{ currentLedger: number; items: SessionItem[] }>(`/v1/accounts/${address}/sessions`),
  createSession: (address: string, body: Record<string, unknown>) =>
    api.post<{ id: string; state: string }>(`/v1/accounts/${address}/sessions`, body),
  revokeSession: (address: string, ruleId: number, txHash?: string) =>
    api.delete<{ success: true }>(
      `/v1/accounts/${address}/sessions/${ruleId}${txHash ? `?txHash=${txHash}` : ''}`,
    ),
};

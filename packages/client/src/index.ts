// Cliente tipado da Abstraction API.
//
// Os tipos saem de src/schema.d.ts, gerado do openapi.json do serviço — não são
// escritos à mão. Se a API mudar e a spec for regenerada, o que quebra é a
// compilação aqui, não uma chamada em produção.
//
// Sem dependência de runtime: usa o `fetch` nativo (Node ≥ 18).
import type { components, paths } from './schema.js';

// ── Tipos derivados da spec ─────────────────────────────────────────────────

type JsonOf<T> = T extends { content: { 'application/json': infer R } } ? R : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? JsonOf<R> : never;

type Schemas = components['schemas'];

export type AccountState = Schemas['AccountState'];
export type AccountSummary = Schemas['AccountSummary'];
export type Usage = Schemas['Usage'];
export type Sponsorship = Schemas['Sponsorship'];
export type FaucetStatus = Schemas['FaucetStatus'];
export type FaucetClaim = Schemas['FaucetClaim'];
export type LedgerRecord = Schemas['LedgerRecord'];
export type LedgerEntry = Schemas['LedgerEntry'];
export type MasterState = Schemas['MasterState'];
export type SessionGrant = Schemas['SessionGrant'];
export type Anchor = Schemas['Anchor'];
export type AnchorResult = Schemas['AnchorResult'];

/**
 * Códigos de erro que a API devolve.
 *
 * São o contrato estável — a mensagem é para humano, o código é para decidir.
 */
export type ErrorCode =
  | 'INVALID_PARAMS'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'FEE_LIMIT_EXCEEDED'
  | 'ALLOWLIST_EMPTY'
  | 'DEPLOY_NOT_ALLOWED'
  | 'AMBIGUOUS_SPONSOR'
  | 'NO_CHANNEL_AVAILABLE'
  | 'ONCHAIN_FAILED'
  | 'ACCOUNT_NOT_DEPLOYED'
  | 'FAUCET_COOLDOWN'
  | 'FAUCET_DRY'
  | 'FAUCET_IN_FLIGHT'
  | 'FAUCET_FAILED'
  | 'NO_GRANT'
  | 'QUOTA_EXCEEDED'
  | 'UUID_TAKEN'
  | 'NOT_OWNER'
  | 'NOT_CONFIGURED'
  | 'ALREADY_ISSUED'
  | 'INTERNAL'
  | (string & {});

export class AbstractionError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status: number,
    readonly body: unknown = undefined,
  ) {
    super(message);
    this.name = 'AbstractionError';
  }

  /** Vale tentar de novo? Cota estourada e UUID repetido, não. */
  get retryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 503 ||
      this.code === 'NO_CHANNEL_AVAILABLE' ||
      this.status >= 500
    );
  }
}

export interface ClientOptions {
  /** Ex.: `https://abstraction.interno`. */
  baseUrl: string;
  /** Secret key do app (`sk_…`). */
  secretKey: string;
  /** Timeout por requisição. Default: 30s. */
  timeoutMs?: number;
  /**
   * Tentativas para requisições IDEMPOTENTES (GET). Default: 3.
   *
   * Escritas não são retentadas automaticamente: repetir um mint sem controle
   * gastaria a cota que o tenant concedeu. `mintAll` trata isso explicitamente.
   */
  retries?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

export class AbstractionClient {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl é obrigatório');
    if (!options.secretKey) throw new Error('secretKey é obrigatório');

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.secretKey = options.secretKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    attempt = 1,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.secretKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      const error = new AbstractionError(
        aborted ? `tempo esgotado após ${this.timeoutMs}ms` : 'falha de rede',
        aborted ? 'TIMEOUT' : 'NETWORK',
        0,
      );
      if (method === 'GET' && attempt < this.retries) {
        await delay(attempt);
        return this.request<T>(method, path, body, attempt + 1);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      const error = new AbstractionError(
        (payload.error as string) ?? `HTTP ${response.status}`,
        (payload.errorCode as ErrorCode) ?? 'INTERNAL',
        response.status,
        payload,
      );
      // Só GET é retentado: repetir uma escrita sem controle pode duplicar efeito.
      if (method === 'GET' && error.retryable && attempt < this.retries) {
        await delay(attempt);
        return this.request<T>(method, path, body, attempt + 1);
      }
      throw error;
    }

    return payload as T;
  }

  // ── Contas ────────────────────────────────────────────────────────────────

  readonly accounts = {
    /**
     * Registra uma smart account e a amarra a um usuário do seu sistema.
     *
     * A conta precisa existir on-chain; a API confere antes de gravar.
     */
    register: (input: {
      contractId: string;
      externalId?: string;
      label?: string;
      credentialId?: string;
      publicKeyHex?: string;
      deployTxHash?: string;
    }): Promise<Ok<paths['/v1/accounts']['post']>> =>
      this.request('POST', '/v1/accounts', input),

    /** Busca a conta pelo id do usuário no seu sistema. */
    byExternalId: (externalId: string): Promise<Ok<paths['/v1/accounts']['get']>> =>
      this.request('GET', `/v1/accounts?externalId=${encodeURIComponent(externalId)}`),

    /** Saldo, status e a allowance gravada no Treasury. */
    get: (address: string): Promise<Ok<paths['/v1/accounts/{address}']['get']>> =>
      this.request('GET', `/v1/accounts/${address}`),

    /** Cota de taxas patrocinadas do dia. */
    usage: (address: string): Promise<Ok<paths['/v1/accounts/{address}/usage']['get']>> =>
      this.request('GET', `/v1/accounts/${address}/usage`),

    /** Histórico de patrocínios. */
    sponsorships: (
      address: string,
      params: { limit?: number; offset?: number } = {},
    ): Promise<Ok<paths['/v1/accounts/{address}/sponsorships']['get']>> =>
      this.request('GET', `/v1/accounts/${address}/sponsorships${query(params)}`),

    /** Itens em posse da conta, paginados (até 50 por página). */
    items: (
      address: string,
      params: { limit?: number; offset?: number } = {},
    ): Promise<Ok<paths['/v1/accounts/{address}/ledger']['get']>> =>
      this.request('GET', `/v1/accounts/${address}/ledger${query(params)}`),
  };

  // ── Faucet (testnet) ──────────────────────────────────────────────────────

  readonly faucet = {
    status: (address: string): Promise<FaucetStatus> =>
      this.request('GET', `/v1/accounts/${address}/faucet`),

    /** XLM de testnet + ativação da cota. Uma vez por período de cooldown. */
    claim: (address: string): Promise<FaucetClaim> =>
      this.request('POST', `/v1/accounts/${address}/faucet`),

    /** Reenvia só a ativação da cota, quando o XLM chegou mas ela não fechou. */
    retryAllowance: (
      address: string,
    ): Promise<Ok<paths['/v1/accounts/{address}/faucet/allowance']['post']>> =>
      this.request('POST', `/v1/accounts/${address}/faucet/allowance`),
  };

  // ── Conta mestre ──────────────────────────────────────────────────────────

  readonly master = {
    /** Conta mestre, chave do serviço e quanto da cota já foi consumido. */
    get: (): Promise<MasterState> => this.request('GET', '/v1/master'),

    set: (contractId: string): Promise<Ok<paths['/v1/master']['post']>> =>
      this.request('POST', '/v1/master', { contractId }),

    /**
     * Provisiona a conta mestre inteira — deploy + as duas permissões.
     *
     * Sem passkey e sem browser: o tenant não assina nada. Idempotente, então
     * chamar de novo completa o que faltou em vez de duplicar.
     */
    provision: (
      input: {
        ledgerMaxItems?: number;
        anchorMaxItems?: number;
        periodLedgers?: number;
      } = {},
    ): Promise<Ok<paths['/v1/master/provision']['post']>> =>
      this.request('POST', '/v1/master/provision', input),

    /**
     * Registra um grant que o browser já criou com a passkey do tenant.
     *
     * `target` escolhe o contrato: `ledger` é o inventário de itens, `anchor` é
     * o histórico contábil. Cada um tem cota própria — registrar um não mexe no
     * outro.
     */
    grant: (input: {
      contextRuleId?: number | null;
      maxItems: number;
      periodLedgers: number;
      grantTxHash?: string;
      target?: 'ledger' | 'anchor';
    }): Promise<Ok<paths['/v1/master/grant']['post']>> =>
      this.request('POST', '/v1/master/grant', input),

    revokeGrant: (
      target: 'ledger' | 'anchor' = 'ledger',
    ): Promise<Ok<paths['/v1/master/grant']['delete']>> =>
      this.request('DELETE', `/v1/master/grant?target=${target}`),
  };

  // ── Ledger ────────────────────────────────────────────────────────────────

  readonly ledger = {
    /**
     * Minta um lote. Até `MAX_BATCH` itens por chamada. Idempotente por UUID:
     * repetir um lote já mintado devolve `alreadyMinted` com o hash original.
     *
     * O limite não é escolha de desenho: é o teto de recursos de uma transação
     * Soroban. Para inventários grandes use `mintAll`.
     */
    // `async` de propósito: a validação abaixo precisa REJEITAR, não lançar de
    // forma síncrona — senão quem chama com `.catch()` não pega o erro.
    mint: async (input: {
      uuids: string[];
      name: string;
      fields?: Record<string, string>;
      metadata?: Record<string, unknown>;
    }): Promise<Ok<paths['/v1/ledger/mint']['post']>> => {
      if (input.uuids.length === 0 || input.uuids.length > MAX_BATCH) {
        throw new AbstractionError(
          `envie de 1 a ${MAX_BATCH} uuids por chamada`,
          'INVALID_PARAMS',
          0,
        );
      }
      return this.request('POST', '/v1/ledger/mint', input);
    },

    /** A venda: passa a posse de um item. */
    transfer: (input: {
      uuid: string;
      to: string;
      metadata?: Record<string, unknown>;
    }): Promise<Ok<paths['/v1/ledger/transfer']['post']>> =>
      this.request('POST', '/v1/ledger/transfer', input),

    list: (
      params: { limit?: number; offset?: number; owner?: string } = {},
    ): Promise<Ok<paths['/v1/ledger']['get']>> =>
      this.request('GET', `/v1/ledger${query(params)}`),

    get: (uuid: string): Promise<Ok<paths['/v1/ledger/{uuid}']['get']>> =>
      this.request('GET', `/v1/ledger/${encodeURIComponent(uuid)}`),

    /** Eventos com o payload completo, que fica fora da chain. */
    entries: (
      params: { limit?: number; offset?: number } = {},
    ): Promise<Ok<paths['/v1/ledger/entries']['get']>> =>
      this.request('GET', `/v1/ledger/entries${query(params)}`),

    /**
     * Ancora um evento de negócio — o que **não** é item.
     *
     * Compra de crédito, dedução, reembolso, split: coisas sem dono, que
     * precisam de prova de que aconteceram. Não gastam a cota de mint; o alvo é
     * o contrato de âncora, que tem grant próprio.
     *
     * `amount` é inteiro na MENOR unidade. O campo on-chain é `i128` e não
     * aceita fracionário — mande `1990`, não `19.90`.
     *
     * Não deduplica: mandar duas vezes grava dois eventos. Quem sabe se a
     * repetição é erro é quem chama.
     */
    record: (input: {
      tenantId: string;
      kind: string;
      reference?: string;
      payload?: Record<string, unknown> | string;
      amount?: string | number | bigint;
    }): Promise<Ok<paths['/v1/ledger/record']['post']>> =>
      this.request('POST', '/v1/ledger/record', {
        ...input,
        amount: input.amount === undefined ? undefined : String(input.amount),
      }),

    /** O histórico de âncoras, com o payload que ficou fora da chain. */
    records: (
      params: { limit?: number; offset?: number; kind?: string; reference?: string } = {},
    ): Promise<Ok<paths['/v1/ledger/records']['get']>> =>
      this.request('GET', `/v1/ledger/records${query(params)}`),
  };

  /**
   * Minta um inventário inteiro, em lotes.
   *
   * Um inventário de 10.000 são ~100 transações patrocinadas. Como cada lote é
   * uma transação, uma falha no meio deixa os anteriores mintados — por isso o
   * retorno diz o que passou e o que não, em vez de estourar e perder o rastro.
   *
   * Não retenta sozinho: um lote recusado por cota esgotada só passaria depois
   * que o tenant aumentasse o teto, e insistir gastaria fee à toa.
   */
  async mintAll(input: {
    uuids: string[];
    name: string;
    fields?: Record<string, string>;
    metadata?: Record<string, unknown>;
    onProgress?: (progress: { minted: number; total: number; hash: string }) => void;
  }): Promise<{
    minted: string[];
    failed: Array<{ uuids: string[]; error: AbstractionError }>;
    hashes: string[];
  }> {
    const minted: string[] = [];
    const failed: Array<{ uuids: string[]; error: AbstractionError }> = [];
    const hashes: string[] = [];

    for (const chunk of chunks(input.uuids, MAX_BATCH)) {
      try {
        const result = await this.ledger.mint({
          uuids: chunk,
          name: input.name,
          fields: input.fields,
          metadata: input.metadata,
        });
        minted.push(...chunk);
        if (result.hash) hashes.push(result.hash);
        input.onProgress?.({
          minted: minted.length,
          total: input.uuids.length,
          hash: result.hash ?? '',
        });
      } catch (error) {
        if (!(error instanceof AbstractionError)) throw error;
        failed.push({ uuids: chunk, error });
        // Cota esgotada não melhora com insistência: os lotes seguintes
        // falhariam igual, queimando tempo.
        if (error.code === 'QUOTA_EXCEEDED') break;
      }
    }

    return { minted, failed, hashes };
  }

  /** Health do serviço. Não exige autenticação, mas usa a mesma baseUrl. */
  health(): Promise<Ok<paths['/health/ready']['get']>> {
    return this.request('GET', '/health/ready');
  }
}

/** Itens por transação, espelhando `MAX_BATCH` do contrato demo-ledger. */
export const MAX_BATCH = 10;

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

const delay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 200));

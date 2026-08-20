import { describe, expect, it, vi } from 'vitest';
import { AbstractionClient, AbstractionError, MAX_BATCH, type LedgerRecord } from '../src/index.js';

/** Servidor falso: devolve as respostas na ordem e registra o que recebeu. */
function stub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let index = 0;

  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const client = new AbstractionClient({
    baseUrl: 'https://api.local',
    secretKey: 'sk_test',
    fetch: fetchStub as unknown as typeof fetch,
    retries: 3,
  });

  return { client, calls, fetchStub };
}

describe('autenticação e forma da requisição', () => {
  it('manda a secret key como bearer', async () => {
    const { client, fetchStub } = stub([{ body: { success: true, account: {} } }]);
    await client.accounts.byExternalId('user-42');

    const init = fetchStub.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
  });

  it('escapa o id externo na query', async () => {
    const { client, calls } = stub([{ body: { success: true, account: {} } }]);
    await client.accounts.byExternalId('user 42/naughty');
    expect(calls[0]!.url).toContain('externalId=user%2042%2Fnaughty');
  });
});

describe('erros', () => {
  it('vira AbstractionError com o código da API', async () => {
    const { client } = stub([
      { status: 403, body: { success: false, error: 'cota acabou', errorCode: 'QUOTA_EXCEEDED' } },
    ]);

    await expect(client.ledger.mint({ uuids: ['a'], name: 'X' })).rejects.toMatchObject({
      name: 'AbstractionError',
      code: 'QUOTA_EXCEEDED',
      status: 403,
    });
  });

  it('cota esgotada não é retentável; indisponibilidade é', () => {
    expect(new AbstractionError('x', 'QUOTA_EXCEEDED', 403).retryable).toBe(false);
    expect(new AbstractionError('x', 'UUID_TAKEN', 409).retryable).toBe(false);
    expect(new AbstractionError('x', 'NO_CHANNEL_AVAILABLE', 503).retryable).toBe(true);
    expect(new AbstractionError('x', 'RATE_LIMITED', 429).retryable).toBe(true);
  });
});

describe('retry', () => {
  it('retenta GET quando o serviço está indisponível', async () => {
    const { client, fetchStub } = stub([
      { status: 503, body: { errorCode: 'NO_CHANNEL_AVAILABLE', error: 'ocupado' } },
      { status: 200, body: { success: true, spentStroops: '0' } },
    ]);

    await client.accounts.usage('CABC');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('NÃO retenta escrita — repetir um mint gastaria a cota do tenant', async () => {
    const { client, fetchStub } = stub([
      { status: 503, body: { errorCode: 'NO_CHANNEL_AVAILABLE', error: 'ocupado' } },
    ]);

    await expect(client.ledger.mint({ uuids: ['a'], name: 'X' })).rejects.toBeInstanceOf(
      AbstractionError,
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('mint em lote', () => {
  it('recusa lote acima do limite antes de chamar a rede', async () => {
    const { client, fetchStub } = stub([{ body: {} }]);
    const uuids = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `uuid-${i}`);

    await expect(client.ledger.mint({ uuids, name: 'X' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('mintAll fatia o inventário em transações do tamanho do limite', async () => {
    const { client, calls } = stub([{ body: { success: true, minted: 100, hash: 'abc' } }]);
    const uuids = Array.from({ length: 250 }, (_, i) => `uuid-${i}`);

    const result = await client.mintAll({ uuids, name: 'Ingresso' });

    expect(calls).toHaveLength(3);
    expect((calls[0]!.body as { uuids: string[] }).uuids).toHaveLength(100);
    expect((calls[2]!.body as { uuids: string[] }).uuids).toHaveLength(50);
    expect(result.minted).toHaveLength(250);
    expect(result.failed).toHaveLength(0);
  });

  it('mintAll para quando a cota acaba, e diz o que passou', async () => {
    const { client, fetchStub } = stub([
      { body: { success: true, minted: 100, hash: 'h1' } },
      { status: 403, body: { errorCode: 'QUOTA_EXCEEDED', error: 'cota acabou' } },
    ]);
    const uuids = Array.from({ length: 300 }, (_, i) => `uuid-${i}`);

    const result = await client.mintAll({ uuids, name: 'Ingresso' });

    // O terceiro lote nem é tentado: insistir queimaria fee sem chance de passar.
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(result.minted).toHaveLength(100);
    expect(result.failed[0]!.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('mintAll reporta progresso', async () => {
    const { client } = stub([{ body: { success: true, minted: 100, hash: 'h' } }]);
    const progress: number[] = [];

    await client.mintAll({
      uuids: Array.from({ length: 150 }, (_, i) => `u${i}`),
      name: 'X',
      onProgress: (p) => progress.push(p.minted),
    });

    expect(progress).toEqual([100, 150]);
  });
});

describe('tipos vindos da spec', () => {
  it('LedgerRecord carrega os campos que o consumidor precisa', () => {
    // Asserção de tipo: se a spec mudar e algum campo sumir, isto não compila.
    const record: LedgerRecord = {
      uuid: '6f1c0b2e-1111-4000-8000-000000000001',
      owner: 'CABC',
      minter: 'CDEF',
      name: 'Ingresso',
      uri: '',
      fields: { campanha: 'turne-2026' },
      mintedAt: 1_800_000_000,
      mintedLedger: 4242,
      transfers: 0,
    };

    expect(record.fields.campanha).toBe('turne-2026');
    expect(record.minter).not.toBe(record.owner);
  });
});

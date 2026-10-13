// Fila de escrita por contrato. Com índices por contador, duas transações
// simultâneas no mesmo contrato travam ao aplicar; a fila faz a segunda esperar
// a vez. A primeira versão esperava segurando conexão do pool e, com 10
// requisições, deixava quem tinha o lock sem conexão para trabalhar.
import { afterAll, describe, expect, it } from 'vitest';

process.env.NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= 'postgres://abstraction:abstraction@localhost:5434/abstraction';

const { pool } = await import('../src/db/pool.js');
const { withContractLock, ContractBusyError } = await import('../src/db/queries/contractLock.js');

afterAll(async () => {
  await pool.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withContractLock', () => {
  it('serializa escritas no mesmo contrato, na ordem de chegada', async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string) =>
      withContractLock('C-TESTE-SERIAL', 10_000, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(`in:${name}`);
        await sleep(50);
        order.push(`out:${name}`);
        running -= 1;
      });

    await Promise.all(['a', 'b', 'c'].map(job));
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['in:a', 'out:a', 'in:b', 'out:b', 'in:c', 'out:c']);
  });

  it('mais requisições do que conexões no pool não travam (quem espera não segura conexão)', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) =>
      withContractLock('C-TESTE-POOL', 20_000, async () => {
        // Usa o pool dentro da seção crítica, como o mint real faz.
        await pool.query('SELECT 1');
        return i;
      }),
    );
    const results = await Promise.all(jobs);
    expect(results).toHaveLength(25);
  });

  it('desiste com CONTRACT_BUSY quando a fila não anda a tempo — sem furar a fila', async () => {
    let release!: () => void;
    const holder = withContractLock(
      'C-TESTE-BUSY',
      10_000,
      () => new Promise<void>((r) => (release = r)),
    );
    await sleep(50);
    await expect(withContractLock('C-TESTE-BUSY', 200, async () => 1)).rejects.toBeInstanceOf(
      ContractBusyError,
    );

    // Quem chega depois do que desistiu ainda espera o dono atual.
    let ran = false;
    const after = withContractLock('C-TESTE-BUSY', 10_000, async () => {
      ran = true;
    });
    await sleep(100);
    expect(ran).toBe(false);
    release();
    await holder;
    await after;
    expect(ran).toBe(true);
  });

  it('contratos diferentes não esperam um pelo outro', async () => {
    let release!: () => void;
    const holder = withContractLock('C-TESTE-X', 10_000, () => new Promise<void>((r) => (release = r)));
    await sleep(30);
    await expect(withContractLock('C-TESTE-Y', 1_000, async () => 'ok')).resolves.toBe('ok');
    release();
    await holder;
  });
});

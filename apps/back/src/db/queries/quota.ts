// Quota diária de taxa patrocinada, por smart account.
//
// Isto substitui o `Map` em memória de services/relayer-proxy/src/policy.ts:38,
// que zerava a cada restart, vazava para sempre (nunca era podado) e, com mais
// de uma réplica, multiplicava o teto — cada processo tinha a sua contagem.
//
// O ciclo é reserve → settle. Reserva-se o TETO que a transação pode custar;
// na liquidação devolve-se o teto e cobra-se o `feeCharged` real.
import type { PoolClient } from 'pg';
import { pool, tx } from '../pool.js';

export interface QuotaSnapshot {
  reserved: bigint;
  settled: bigint;
  txCount: number;
}

/** Dia UTC — casa com o `day_bucket` do Treasury (`timestamp / 86400`). */
export const DAY_SQL = "(now() AT TIME ZONE 'utc')::date";

/**
 * Reserva `amount` da quota do dia. Retorna `null` se estourou o teto.
 *
 * Por que dois statements em vez de um upsert: o INSERT ... ON CONFLICT tem um
 * braço INSERT que não passa pelo WHERE, então o primeiro pedido do dia
 * escaparia da checagem. E um SELECT seguido de UPDATE tem janela de corrida.
 *
 * O `UPDATE ... WHERE` é o que dá a garantia: ele pega lock exclusivo de linha
 * e, em READ COMMITTED, uma transação que fica bloqueada nele reavalia o WHERE
 * contra a versão já atualizada da linha depois do COMMIT da primeira
 * (EvalPlanQual). Ou seja, a soma nunca passa do teto mesmo com N réplicas —
 * o lock é do Postgres, não precisa de Redis.
 */
export async function reserve(
  client: PoolClient,
  appId: string,
  smartAccount: string,
  amount: bigint,
  maxPerDay: bigint,
): Promise<QuotaSnapshot | null> {
  await client.query(
    `INSERT INTO fee_quota_daily (app_id, smart_account, day_utc)
     VALUES ($1, $2, ${DAY_SQL})
     ON CONFLICT (app_id, smart_account, day_utc) DO NOTHING`,
    [appId, smartAccount],
  );

  const res = await client.query<{
    reserved_stroops: bigint;
    settled_stroops: bigint;
    tx_count: number;
  }>(
    `UPDATE fee_quota_daily
        SET reserved_stroops = reserved_stroops + $3,
            tx_count         = tx_count + 1,
            updated_at       = now()
      WHERE app_id = $1 AND smart_account = $2 AND day_utc = ${DAY_SQL}
        AND reserved_stroops + settled_stroops + $3 <= $4
      RETURNING reserved_stroops, settled_stroops, tx_count`,
    [appId, smartAccount, amount.toString(), maxPerDay.toString()],
  );

  const row = res.rows[0];
  if (!row) return null;
  return {
    reserved: BigInt(row.reserved_stroops),
    settled: BigInt(row.settled_stroops),
    txCount: row.tx_count,
  };
}

/**
 * Fecha a reserva: devolve o teto e cobra o que a rede cobrou de fato.
 * `charged = 0n` libera tudo (transação falhou ou nem foi submetida).
 */
export async function settle(
  client: PoolClient,
  appId: string,
  smartAccount: string,
  dayUtc: string,
  reservedAmount: bigint,
  charged: bigint,
): Promise<void> {
  await client.query(
    `UPDATE fee_quota_daily
        SET reserved_stroops = GREATEST(reserved_stroops - $4, 0),
            settled_stroops  = settled_stroops + $5,
            updated_at       = now()
      WHERE app_id = $1 AND smart_account = $2 AND day_utc = $3`,
    [appId, smartAccount, dayUtc, reservedAmount.toString(), charged.toString()],
  );
}

export async function snapshot(
  appId: string,
  smartAccount: string,
): Promise<QuotaSnapshot> {
  const res = await pool.query<{
    reserved_stroops: bigint;
    settled_stroops: bigint;
    tx_count: number;
  }>(
    `SELECT reserved_stroops, settled_stroops, tx_count
       FROM fee_quota_daily
      WHERE app_id = $1 AND smart_account = $2 AND day_utc = ${DAY_SQL}`,
    [appId, smartAccount],
  );
  const row = res.rows[0];
  if (!row) return { reserved: 0n, settled: 0n, txCount: 0 };
  return {
    reserved: BigInt(row.reserved_stroops),
    settled: BigInt(row.settled_stroops),
    txCount: row.tx_count,
  };
}

/**
 * Libera reservas órfãs — processo morto entre a reserva e a liquidação.
 * Sem isso, um kill -9 no meio de um relay travaria a quota daquela conta até
 * a virada do dia.
 */
export async function reapStaleReservations(): Promise<number> {
  return tx(async (client) => {
    const stale = await client.query<{
      id: string;
      app_id: string;
      smart_account: string;
      day_utc: string;
      reserved_stroops: bigint;
    }>(
      `SELECT id, app_id, smart_account, day_utc, reserved_stroops
         FROM sponsorships
        WHERE state = 'reserved' AND reserved_until < now()
        FOR UPDATE SKIP LOCKED
        LIMIT 100`,
    );

    for (const row of stale.rows) {
      if (row.smart_account) {
        await settle(
          client,
          row.app_id,
          row.smart_account,
          row.day_utc,
          BigInt(row.reserved_stroops),
          0n,
        );
      }
      await client.query(
        `UPDATE sponsorships SET state = 'released', settled_at = now() WHERE id = $1`,
        [row.id],
      );
    }
    return stale.rows.length;
  });
}

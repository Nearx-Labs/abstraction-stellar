import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardTitle, Progress, Skeleton } from '@/components/ui';
import { endpoints } from '@/lib/api';
import { formatDuration, formatXlm } from '@/lib/utils';

/**
 * Quanto da cota diária de taxa patrocinada já foi usado.
 *
 * `reservado` aparece somado ao gasto porque é dinheiro comprometido: uma
 * transação em voo já segurou aquele teto. Contar só o liquidado deixaria o
 * medidor mentir por alguns segundos.
 */
export function SponsorshipMeter({ address }: { address: string }) {
  const { data, isPending } = useQuery({
    queryKey: ['usage', address],
    queryFn: () => endpoints.usage(address),
    refetchInterval: 15_000,
  });

  if (isPending || !data) {
    return (
      <Card>
        <CardTitle>Taxas patrocinadas hoje</CardTitle>
        <Skeleton className="h-2 w-full" />
        <Skeleton className="mt-3 h-4 w-48" />
      </Card>
    );
  }

  const spent = BigInt(data.spentStroops) + BigInt(data.reservedStroops);
  const max = BigInt(data.maxPerDayStroops);
  const percent = max > 0n ? Number((spent * 10_000n) / max) / 100 : 0;
  const tone = percent > 95 ? 'danger' : percent > 80 ? 'warning' : 'primary';

  const resetsIn = Math.max(
    0,
    Math.floor((new Date(data.resetsAt).getTime() - Date.now()) / 1000),
  );

  return (
    <Card>
      <CardTitle>Taxas patrocinadas hoje</CardTitle>

      <p className="tabular mb-3 text-lg font-semibold text-fg">
        {formatXlm(spent)} <span className="text-sm font-normal text-muted">/ {formatXlm(max)} XLM</span>
      </p>

      <Progress value={percent} tone={tone} />

      <p className="mt-3 text-xs text-muted">
        {data.txCount} {data.txCount === 1 ? 'transação' : 'transações'} · reinicia{' '}
        {resetsIn > 0 ? `em ${formatDuration(resetsIn)}` : 'agora'}
      </p>
      <p className="mt-1 text-xs text-muted">
        Limite por transação: {formatXlm(data.maxPerTxStroops)} XLM
      </p>

      {!data.onchain.hasAllowance && (
        <div className="mt-4">
          <Alert>
            Sua conta ainda não tem limite registrado no contrato Treasury. As transações
            continuam sendo patrocinadas, mas o gasto não fica auditável on-chain — use o
            faucet para registrar.
          </Alert>
        </div>
      )}
    </Card>
  );
}

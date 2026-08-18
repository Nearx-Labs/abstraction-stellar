import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardTitle, Dot, Skeleton } from '@/components/ui';
import { endpoints } from '@/lib/api';
import { contractUrl } from '@/lib/config';
import { formatXlm, truncateAddress } from '@/lib/utils';

export function AccountCard({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const { data, isPending, isError } = useQuery({
    queryKey: ['account', address],
    queryFn: () => endpoints.account(address),
    refetchInterval: 30_000,
  });

  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <Card>
      <CardTitle>Sua conta</CardTitle>

      <dl className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-sm text-muted">Endereço</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono text-sm text-fg">{truncateAddress(address)}</span>
            <button
              onClick={copy}
              aria-label="Copiar endereço"
              className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            </button>
            <a
              href={contractUrl(address)}
              target="_blank"
              rel="noopener"
              aria-label="Ver no explorer"
              className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </dd>
        </div>

        <div className="flex items-center justify-between gap-3">
          <dt className="text-sm text-muted">Saldo</dt>
          <dd className="tabular text-lg font-semibold text-fg">
            {isPending ? (
              <Skeleton className="h-6 w-28" />
            ) : isError ? (
              <span title="Não foi possível ler o saldo agora" className="text-muted">
                —
              </span>
            ) : (
              <>
                {formatXlm(data.balanceStroops, 7)}{' '}
                <span className="text-sm font-normal text-muted">XLM</span>
              </>
            )}
          </dd>
        </div>

        <div className="flex items-center justify-between gap-3">
          <dt className="text-sm text-muted">Status</dt>
          <dd>
            {isPending ? (
              <Skeleton className="h-6 w-32" />
            ) : (
              <Badge tone={data?.account.status === 'deployed' ? 'primary' : 'warning'}>
                <Dot tone={data?.account.status === 'deployed' ? 'primary' : 'warning'} />
                {data?.account.status === 'deployed' ? 'Ativa · patrocinada' : 'Implantando'}
              </Badge>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

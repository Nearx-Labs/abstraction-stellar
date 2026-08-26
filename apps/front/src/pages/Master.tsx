// A conta mestre do tenant e a permissão que ela concede ao serviço.
//
// É a tela que responde "o que exatamente eu estou autorizando": um contrato,
// um número de itens, uma janela — e quem recusa o item seguinte é o contrato,
// não uma promessa do backend.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, KeySquare, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Dot,
  Field,
  Input,
  Progress,
  Skeleton,
} from '@/components/ui';
import { contractUrl, txUrl } from '@/lib/config';
import { useWallet } from '@/hooks/useWallet';
import { kit } from '@/lib/kit';
import {
  grantPermission,
  masterApi,
  revokePermission,
  type GrantTarget,
  type MasterState,
} from '@/lib/master';
import { truncateAddress } from '@/lib/utils';

const LEDGERS_PER_DAY = 17_280;
const WINDOWS = [
  { label: '1 dia', days: 1 },
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
];

export function MasterPage({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const { custodial } = useWallet();
  const { data, isPending } = useQuery({
    queryKey: ['master'],
    queryFn: () => masterApi.state(),
    refetchInterval: 30_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['master'] });

  const claim = useMutation({
    mutationFn: () => masterApi.setAccount(address),
    onSuccess: () => {
      toast.success('Esta conta agora é a mestre do tenant.');
      void invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (isPending || !data) {
    return (
      <Card>
        <CardTitle>Conta mestre</CardTitle>
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  const isMaster = data.masterAccount === address;

  return (
    <>
      <Card>
        <CardTitle>Conta mestre do tenant</CardTitle>

        {!data.masterAccount ? (
          <>
            <p className="mb-4 text-sm text-muted">
              A conta mestre é dona do inventário: ela minta os itens e é quem transfere a posse
              numa venda. Escolha uma e o serviço passa a poder operar dentro do teto que você
              conceder.
            </p>
            <Button full loading={claim.isPending} onClick={() => claim.mutate()}>
              <KeySquare className="size-4" /> Usar esta conta como mestre
            </Button>
          </>
        ) : (
          <dl className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-sm text-muted">Conta</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono text-sm text-fg">
                  {truncateAddress(data.masterAccount)}
                </span>
                {isMaster && <Badge tone="primary">esta conta</Badge>}
                <a
                  href={contractUrl(data.masterAccount)}
                  target="_blank"
                  rel="noopener"
                  className="text-muted hover:text-fg"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              </dd>
            </div>

            <div className="flex items-center justify-between gap-3">
              <dt className="text-sm text-muted">Chave do serviço</dt>
              <dd
                className="font-mono text-xs text-muted"
                title={data.signer.publicKeyHex}
              >
                {data.signer.publicKeyHex.slice(0, 16)}…
              </dd>
            </div>
          </dl>
        )}
      </Card>

      {data.masterAccount && (
        <>
          <GrantCard
            target="ledger"
            state={data}
            isMaster={isMaster}
            custodial={custodial}
            onChanged={invalidate}
          />
          <GrantCard
            target="anchor"
            state={data}
            isMaster={isMaster}
            custodial={custodial}
            onChanged={invalidate}
          />
        </>
      )}
    </>
  );
}

/** O que cada alvo autoriza, em português de quem vai clicar. */
const COPY: Record<
  GrantTarget,
  { title: string; unit: string; fieldLabel: string; what: string; ruleName: string }
> = {
  ledger: {
    title: 'Permissão de mint',
    unit: 'itens',
    fieldLabel: 'Itens autorizados',
    what:
      'registrar as chaves compradas no inventário. Cada chave é um item, ' +
      'identificado pelo mesmo UUID que o banco guarda.',
    ruleName: 'mint do serviço',
  },
  anchor: {
    title: 'Permissão de âncora',
    unit: 'eventos',
    fieldLabel: 'Eventos autorizados',
    what:
      'ancorar eventos que não são item — compra de crédito, dedução, reembolso, ' +
      'split. Sobe só o hash do registro; o conteúdo fica no banco.',
    ruleName: 'âncora do serviço',
  },
};

/**
 * Um cartão por alvo.
 *
 * Duas cotas separadas, e por isso dois cartões: juntar os números numa tela só
 * sugeriria um teto compartilhado, que é exatamente o que a separação evita.
 */
function GrantCard({
  target,
  state,
  isMaster,
  custodial,
  onChanged,
}: {
  target: GrantTarget;
  state: MasterState;
  isMaster: boolean;
  /** Conta provisionada pelo serviço: o browser não tem chave para assinar. */
  custodial: boolean;
  onChanged: () => void;
}) {
  const copy = COPY[target];
  const { contract, grant: current, quota } = state.targets[target];

  const [maxItems, setMaxItems] = useState(target === 'ledger' ? '10000' : '50000');
  const [days, setDays] = useState(30);

  const itemsValid = Number(maxItems) > 0 && Number(maxItems) <= 1_000_000;

  const grant = useMutation({
    // Custodial: quem assina é o serviço, então a concessão é uma chamada de
    // API. Com passkey, quem assina é o dono, aqui no browser.
    mutationFn: () =>
      custodial
        ? masterApi
            .provision({
              [target === 'ledger' ? 'ledgerMaxItems' : 'anchorMaxItems']: Number(maxItems),
              periodLedgers: days * LEDGERS_PER_DAY,
            })
            .then((result) => ({
              contextRuleId:
                result.granted.find((g) => g.target === target)?.contextRuleId ?? null,
              txHash: result.granted.find((g) => g.target === target)?.hash,
            }))
        : grantPermission(kit, state, target, Number(maxItems), days * LEDGERS_PER_DAY),
    onSuccess: (result) => {
      toast.success('Permissão concedida.', {
        action: result.txHash
          ? { label: 'Ver transação', onClick: () => window.open(txUrl(result.txHash!), '_blank') }
          : undefined,
      });
      onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revoke = useMutation({
    mutationFn: () => revokePermission(kit, target, current!.contextRuleId!),
    onSuccess: () => {
      toast.success('Permissão revogada.');
      onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardTitle>{copy.title}</CardTitle>

      {current && current.state !== 'revoked' ? (
        <>
          <div className="mb-4 flex items-center gap-2">
            <Badge tone={current.state === 'active' ? 'primary' : 'warning'}>
              <Dot tone={current.state === 'active' ? 'primary' : 'warning'} />
              {current.state === 'active' ? 'ativa' : 'confirmando'}
            </Badge>
            <span className="text-sm text-muted">
              até {current.maxItems.toLocaleString('pt-BR')} {copy.unit} por janela
            </span>
          </div>

          {quota ? (
            <>
              <p className="tabular mb-2 text-lg font-semibold text-fg">
                {quota.used.toLocaleString('pt-BR')}{' '}
                <span className="text-sm font-normal text-muted">
                  de {quota.maxItems.toLocaleString('pt-BR')} {copy.unit}
                </span>
              </p>
              <Progress
                value={(quota.used / Math.max(quota.maxItems, 1)) * 100}
                tone={
                  quota.used / quota.maxItems > 0.9
                    ? 'danger'
                    : quota.used / quota.maxItems > 0.7
                      ? 'warning'
                      : 'primary'
                }
              />
              <p className="mt-2 text-xs text-muted">
                {quota.remaining.toLocaleString('pt-BR')} restantes. O contrato recusa o
                seguinte — não é um limite do nosso servidor.
              </p>
            </>
          ) : (
            <Alert>
              A cota ainda não aparece on-chain. Se acabou de conceder, aguarde a confirmação.
            </Alert>
          )}

          {/*
            Revogar exige assinar pela conta, e numa sessão custodial o browser
            não tem chave. Oferecer o botão só para ele falhar seria pior do que
            não oferecer.
          */}
          {isMaster && !custodial && current.contextRuleId !== null && (
            <div className="mt-5">
              <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>
                <ShieldOff className="size-4" /> Revogar permissão
              </Button>
            </div>
          )}
        </>
      ) : !isMaster && !custodial ? (
        <Alert>
          Entre com a conta mestre ({truncateAddress(state.masterAccount!, 6, 4)}) para conceder
          a permissão — só o dono dela pode autorizar o serviço.
        </Alert>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            Você autoriza a chave do serviço a chamar{' '}
            <a
              href={contractUrl(contract)}
              target="_blank"
              rel="noopener"
              className="text-primary hover:underline"
            >
              um contrato só
            </a>{' '}
            para {copy.what} A chave não administra a conta e não move fundos.
          </p>

          <div className="space-y-4">
            <Field
              label={copy.fieldLabel}
              error={!itemsValid && maxItems !== '' ? 'Informe entre 1 e 1.000.000.' : undefined}
            >
              <Input
                inputMode="numeric"
                value={maxItems}
                onChange={(event) => setMaxItems(event.target.value.replace(/\D/g, ''))}
              />
            </Field>

            <Field label="Janela">
              <div className="flex gap-2">
                {WINDOWS.map((option) => (
                  <button
                    key={option.days}
                    onClick={() => setDays(option.days)}
                    className={
                      days === option.days
                        ? 'flex-1 rounded-xl border border-primary/60 bg-primary/10 px-3 py-2 text-sm text-fg'
                        : 'flex-1 rounded-xl border border-border px-3 py-2 text-sm text-muted transition-colors hover:text-fg'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>

            <p className="text-xs text-muted">
              O serviço poderá registrar até{' '}
              <strong className="text-fg">
                {Number(maxItems || 0).toLocaleString('pt-BR')}
              </strong>{' '}
              {copy.unit} a cada <strong className="text-fg">{days} dia(s)</strong>. Passou disso,
              a transação falha on-chain.
            </p>

            <Button
              full
              size="lg"
              disabled={!itemsValid}
              loading={grant.isPending}
              onClick={() => grant.mutate()}
            >
              <ShieldCheck className="size-4" />
              {custodial ? 'Conceder' : 'Conceder (1 toque na digital)'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

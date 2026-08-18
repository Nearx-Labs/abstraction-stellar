// Session keys: conceder, acompanhar e revogar.
//
// A tela é honesta sobre a principal limitação do desenho: a chave privada da
// sessão vive só nesta aba. Recarregar a página não invalida a regra on-chain,
// mas você perde a chave — e o caminho certo passa a ser revogar.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Plus, ShieldOff } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Dot,
  Field,
  Input,
  Modal,
  Progress,
  Skeleton,
} from '@/components/ui';
import { endpoints, type SessionItem } from '@/lib/api';
import { CONFIG } from '@/lib/config';
import { kit } from '@/lib/kit';
import { grantSession, hasLiveKey, revokeSession } from '@/lib/session';
import { cn, formatDuration, formatXlm, truncateAddress, xlmToStroops } from '@/lib/utils';

const LEDGERS_PER_HOUR = 720;
const DURATIONS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
];

const TARGETS = [
  { label: 'XLM (SAC)', value: CONFIG.xlmSacAddress },
  { label: 'Outro (C-address)', value: 'custom' },
];

function stateBadge(item: SessionItem) {
  if (item.state === 'revoked') {
    return (
      <Badge tone="muted">
        <Dot tone="muted" /> revogada
      </Badge>
    );
  }
  if (item.state === 'expired' || item.expiresInSeconds <= 0) {
    return (
      <Badge tone="muted">
        <Dot tone="muted" /> expirada
      </Badge>
    );
  }
  if (item.state === 'pending') {
    return (
      <Badge tone="warning">
        <Dot tone="warning" /> confirmando
      </Badge>
    );
  }
  if (item.expiresInSeconds < 3600) {
    return (
      <Badge tone="warning">
        <Dot tone="warning" /> expira em {formatDuration(item.expiresInSeconds)}
      </Badge>
    );
  }
  return (
    <Badge tone="primary">
      <Dot tone="primary" /> ativa
    </Badge>
  );
}

export function SessionsPage({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<SessionItem | null>(null);

  const [name, setName] = useState('Sessão do app');
  const [target, setTarget] = useState(CONFIG.xlmSacAddress);
  const [customTarget, setCustomTarget] = useState('');
  const [limit, setLimit] = useState('10');
  const [hours, setHours] = useState(1);

  const { data, isPending } = useQuery({
    queryKey: ['sessions', address],
    queryFn: () => endpoints.sessions(address),
    refetchInterval: 20_000,
  });

  const resolvedTarget = target === 'custom' ? customTarget.trim() : target;
  const targetValid = /^C[A-Z2-7]{55}$/.test(resolvedTarget);
  const limitValue = Number(limit.replace(',', '.'));
  const limitValid = limitValue > 0 && limitValue <= 1000;
  const formValid = name.trim().length > 0 && name.length <= 32 && targetValid && limitValid;

  const create = useMutation({
    mutationFn: () =>
      grantSession(kit, address, resolvedTarget, {
        ttlLedgers: LEDGERS_PER_HOUR * hours,
        spendingLimit: xlmToStroops(limit.replace(',', '.')),
        name: name.trim(),
      }),
    onSuccess: () => {
      toast.success('Sessão criada.');
      setFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['sessions', address] });
      void queryClient.invalidateQueries({ queryKey: ['usage', address] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revoke = useMutation({
    mutationFn: (item: SessionItem) => revokeSession(kit, address, item.contextRuleId!),
    onSuccess: () => {
      toast.success('Sessão revogada.');
      setConfirmRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ['sessions', address] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const expiresAt = new Date(Date.now() + hours * 3600_000);

  return (
    <>
      <Card>
        <CardTitle
          action={
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="size-4" /> Nova session key
            </Button>
          }
        >
          Session keys
        </CardTitle>

        <p className="mb-5 text-sm text-muted">
          Uma session key deixa seu app assinar sozinho, sem pedir a digital toda hora. Ela só
          fala com um contrato, tem teto de gasto e morre na hora que você marcar.
        </p>

        {isPending || !data ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : data.items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-10 text-center">
            <KeyRound className="mx-auto mb-3 size-6 text-muted" />
            <p className="text-sm text-fg">Nenhuma session key ativa.</p>
            <p className="mt-1 text-xs text-muted">
              Crie uma para o seu app assinar sem pedir a digital toda vez.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {data.items.map((item) => {
              const spendingLimit = BigInt(item.spendingLimitStroops);
              const remaining =
                item.remainingStroops === null ? null : BigInt(item.remainingStroops);
              const usedPercent =
                remaining === null || spendingLimit === 0n
                  ? 0
                  : Number(((spendingLimit - remaining) * 100n) / spendingLimit);
              const live = hasLiveKey(item.contextRuleId);
              const revocable =
                item.contextRuleId !== null &&
                item.state !== 'revoked' &&
                item.state !== 'expired';

              return (
                <li key={item.id} className="flex flex-wrap items-center gap-3 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-fg">{item.name}</p>
                      {stateBadge(item)}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-muted">
                      {item.targetContract === CONFIG.xlmSacAddress
                        ? 'XLM (SAC)'
                        : truncateAddress(item.targetContract, 6, 4)}
                    </p>
                    {!live && item.state === 'active' && (
                      <p className="mt-1 text-xs text-warning">
                        chave não está nesta aba — só dá para revogar
                      </p>
                    )}
                  </div>

                  <div className="w-40">
                    {remaining === null ? (
                      <p className="text-xs text-muted">orçamento indisponível</p>
                    ) : (
                      <>
                        <Progress
                          value={usedPercent}
                          tone={usedPercent > 80 ? 'warning' : 'primary'}
                        />
                        <p className="tabular mt-1.5 text-xs text-muted">
                          {formatXlm(remaining, 2)} de {formatXlm(spendingLimit, 2)} XLM
                        </p>
                      </>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant={revocable ? 'danger' : 'ghost'}
                    disabled={!revocable}
                    onClick={() => setConfirmRevoke(item)}
                  >
                    <ShieldOff className="size-3.5" />
                    Revogar
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ── Formulário de grant ────────────────────────────────────────── */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="Nova session key"
        description="Escopo, teto de gasto e prazo são aplicados pelo contrato, não pelo app."
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              Cancelar
            </Button>
            <Button
              full
              loading={create.isPending}
              disabled={!formValid}
              onClick={() => create.mutate()}
            >
              Criar sessão (1 toque na digital)
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nome" hint="Até 32 caracteres.">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} />
          </Field>

          <Field label="Contrato autorizado">
            <div className="space-y-2">
              <div className="flex gap-2">
                {TARGETS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setTarget(option.value)}
                    className={cn(
                      'flex-1 rounded-xl border px-3 py-2 text-sm transition-colors',
                      target === option.value
                        ? 'border-primary/60 bg-primary/10 text-fg'
                        : 'border-border text-muted hover:text-fg',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {target === 'custom' && (
                <Input
                  className="font-mono text-xs"
                  placeholder="C…"
                  value={customTarget}
                  onChange={(event) => setCustomTarget(event.target.value.trim())}
                  spellCheck={false}
                />
              )}
            </div>
          </Field>

          <Field
            label="Teto de gasto (XLM)"
            error={limit !== '' && !limitValid ? 'Informe um valor entre 0 e 1000.' : undefined}
          >
            <Input
              inputMode="decimal"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </Field>

          <Field label="Duração">
            <div className="flex gap-2">
              {DURATIONS.map((option) => (
                <button
                  key={option.hours}
                  onClick={() => setHours(option.hours)}
                  className={cn(
                    'flex-1 rounded-xl border px-3 py-2 text-sm transition-colors',
                    hours === option.hours
                      ? 'border-primary/60 bg-primary/10 text-fg'
                      : 'border-border text-muted hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Field>

          <p className="text-xs text-muted">
            A sessão vai valer até{' '}
            <strong className="text-fg">
              {expiresAt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            </strong>{' '}
            e gastar no máximo <strong className="text-fg">{limit} XLM</strong>.
          </p>

          <Alert>
            Esta sessão vive só nesta aba. Se você recarregar a página, ela continua válida
            on-chain mas você perde a chave — revogue e crie outra.
          </Alert>
        </div>
      </Modal>

      {/* ── Confirmação de revogação ───────────────────────────────────── */}
      <Modal
        open={confirmRevoke !== null}
        onClose={() => setConfirmRevoke(null)}
        title={`Revogar "${confirmRevoke?.name ?? ''}"?`}
        description="A chave para de funcionar imediatamente. Isso pede sua digital."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(null)}>
              Cancelar
            </Button>
            <Button
              full
              variant="danger"
              loading={revoke.isPending}
              onClick={() => confirmRevoke && revoke.mutate(confirmRevoke)}
            >
              Revogar
            </Button>
          </>
        }
      />
    </>
  );
}

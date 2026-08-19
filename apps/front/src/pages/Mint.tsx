// Mint com campos livres + o ledger resultante.
//
// É o caso de uso que fecha o circuito: o usuário preenche um formulário, a
// passkey assina, o relayer paga a taxa, o contrato guarda os campos e o
// registro aparece no ledger — sem seed phrase e sem XLM para a fee.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRightLeft, ExternalLink, Layers, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Field,
  Input,
  Modal,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { CONFIG, contractUrl, txUrl } from '@/lib/config';
import { kit } from '@/lib/kit';
import {
  LIMITS,
  cleanFields,
  mintRecord,
  newUuid,
  transferRecord,
  validateMint,
  type CustomField,
} from '@/lib/mint';
import { truncateAddress } from '@/lib/utils';

interface LedgerRecord {
  uuid: string;
  owner: string;
  minter: string;
  name: string;
  uri: string;
  fields: Record<string, string>;
  mintedAt: number;
  mintedLedger: number;
  transfers: number;
}

const SUGGESTIONS: CustomField[] = [
  { key: 'campanha', value: '' },
  { key: 'lote', value: '' },
  { key: 'serie', value: '' },
];

export function MintPage({ address }: { address: string }) {
  const queryClient = useQueryClient();

  const [uuid, setUuid] = useState(newUuid);
  const [transferTarget, setTransferTarget] = useState<LedgerRecord | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<CustomField[]>([
    { key: '', value: '' },
    { key: '', value: '' },
  ]);

  const ledger = useQuery({
    queryKey: ['ledger'],
    queryFn: () =>
      api.get<{ total: number; contractId: string; items: LedgerRecord[] }>(
        '/v1/ledger?limit=20',
      ),
    refetchInterval: 20_000,
  });

  const input = { uuid, name, uri: '', fields: cleanFields(fields) };
  const validationError = validateMint({ uuid, name, uri: '', fields });

  const mint = useMutation({
    mutationFn: () => mintRecord(kit, address, input),
    onSuccess: (result) => {
      toast.success(result.granted ? 'Permissão concedida e item registrado.' : 'Registrado no ledger.', {
        action: { label: 'Ver transação', onClick: () => window.open(txUrl(result.hash), '_blank') },
      });
      setUuid(newUuid());
      setName('');
      setFields([
        { key: '', value: '' },
        { key: '', value: '' },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['ledger'] });
      void queryClient.invalidateQueries({ queryKey: ['usage', address] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const transfer = useMutation({
    mutationFn: () => {
      if (!transferTarget) throw new Error('nenhum item selecionado');
      return transferRecord(kit, address, transferTarget.uuid, transferTo);
    },
    onSuccess: (result) => {
      toast.success('Posse transferida.', {
        action: { label: 'Ver transação', onClick: () => window.open(txUrl(result.hash), '_blank') },
      });
      setTransferTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['ledger'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function updateField(index: number, patch: Partial<CustomField>) {
    setFields((current) =>
      current.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    );
  }

  const filledCount = cleanFields(fields).length;

  return (
    <>
      <Card>
        <CardTitle
          action={
            <a
              href={contractUrl(CONFIG.demoLedgerAddress)}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              contrato <ExternalLink className="size-3" />
            </a>
          }
        >
          Registrar item
        </CardTitle>

        <p className="mb-5 text-sm text-muted">
          Os campos abaixo entram <strong className="text-fg">dentro do contrato</strong>, não num
          banco de dados. O item é identificado pelo UUID — a mesma chave que o sistema
          consumidor guarda no banco dele — e a taxa é paga pelo sponsor.
        </p>

        <div className="space-y-4">
          <Field
            label="UUID do item"
            hint="Gerado aqui e gravado no banco do sistema consumidor. É a chave dos dois lados."
          >
            <div className="flex gap-2">
              <Input
                className="flex-1 font-mono text-xs"
                value={uuid}
                onChange={(event) => setUuid(event.target.value.trim())}
                spellCheck={false}
              />
              <Button variant="outline" aria-label="Gerar outro UUID" onClick={() => setUuid(newUuid())}>
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </Field>

          <Field label="Nome do item" hint={`Até ${LIMITS.maxNameLen} caracteres.`}>
            <Input
              value={name}
              maxLength={LIMITS.maxNameLen}
              placeholder="Ingresso VIP — Turnê 2026"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-fg">Campos customizados</span>
              <span className="text-xs text-muted">
                {filledCount} de {LIMITS.maxFields}
              </span>
            </div>

            <ul className="space-y-2">
              {fields.map((field, index) => (
                <li key={index} className="flex gap-2">
                  <Input
                    className="flex-1"
                    placeholder="nome do campo"
                    value={field.key}
                    maxLength={LIMITS.maxKeyLen}
                    onChange={(event) => updateField(index, { key: event.target.value })}
                  />
                  <Input
                    className="flex-[2]"
                    placeholder="valor"
                    value={field.value}
                    maxLength={LIMITS.maxValueLen}
                    onChange={(event) => updateField(index, { value: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="md"
                    aria-label="Remover campo"
                    onClick={() => setFields((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={fields.length >= LIMITS.maxFields}
                onClick={() => setFields((current) => [...current, { key: '', value: '' }])}
              >
                <Plus className="size-3.5" /> Adicionar campo
              </Button>
              {SUGGESTIONS.filter(
                (suggestion) => !fields.some((field) => field.key === suggestion.key),
              ).map((suggestion) => (
                <Button
                  key={suggestion.key}
                  size="sm"
                  variant="ghost"
                  onClick={() => setFields((current) => [...current, { ...suggestion }])}
                >
                  + {suggestion.key}
                </Button>
              ))}
            </div>
          </div>

          {validationError && name.length > 0 && (
            <Alert tone="danger">{validationError}</Alert>
          )}

          <Button
            full
            size="lg"
            loading={mint.isPending}
            disabled={validationError !== null}
            onClick={() => mint.mutate()}
          >
            {!mint.isPending && <Sparkles className="size-4" />}
            {mint.isPending ? 'Assinando com a passkey…' : 'Registrar no ledger'}
          </Button>
        </div>
      </Card>

      {/* ── O ledger ────────────────────────────────────────────────────── */}
      <Card>
        <CardTitle>
          Ledger{ledger.data ? ` · ${ledger.data.total} registros` : ''}
        </CardTitle>

        {ledger.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !ledger.data || ledger.data.items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-10 text-center">
            <Layers className="mx-auto mb-3 size-6 text-muted" />
            <p className="text-sm text-fg">O ledger está vazio.</p>
            <p className="mt-1 text-xs text-muted">Registre o primeiro item acima.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {ledger.data.items.map((record) => (
              <li key={record.uuid} className="py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex-1 truncate text-sm font-medium text-fg">{record.name}</p>
                  {record.transfers > 0 && (
                    <Badge tone="muted">
                      {record.transfers} {record.transfers === 1 ? 'troca' : 'trocas'}
                    </Badge>
                  )}
                  {record.owner === address && <Badge tone="primary">seu</Badge>}
                  {record.owner === address && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTransferTarget(record);
                        setTransferTo('');
                      }}
                    >
                      <ArrowRightLeft className="size-3.5" /> Transferir
                    </Button>
                  )}
                </div>

                <p className="mt-1 font-mono text-[11px] text-muted">{record.uuid}</p>

                <p className="mt-0.5 font-mono text-xs text-muted">
                  dono {truncateAddress(record.owner, 6, 4)} · ledger {record.mintedLedger}
                  {record.mintedAt > 0 &&
                    ` · ${new Date(record.mintedAt * 1000).toLocaleString('pt-BR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}`}
                </p>

                {Object.keys(record.fields).length > 0 && (
                  <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {Object.entries(record.fields).map(([key, value]) => (
                      <div key={key} className="flex gap-1.5 text-xs">
                        <dt className="text-muted">{key}:</dt>
                        <dd className="text-fg">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── Transferência: é a venda do marketplace ─────────────────────── */}
      <Modal
        open={transferTarget !== null}
        onClose={() => setTransferTarget(null)}
        title="Transferir item"
        description="A posse passa on-chain para o novo dono. Isso pede sua digital."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTransferTarget(null)}>
              Cancelar
            </Button>
            <Button
              full
              loading={transfer.isPending}
              disabled={!/^[GC][A-Z2-7]{55}$/.test(transferTo)}
              onClick={() => transfer.mutate()}
            >
              Transferir
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-surface-2 p-3">
            <p className="text-sm text-fg">{transferTarget?.name}</p>
            <p className="mt-0.5 font-mono text-[11px] text-muted">{transferTarget?.uuid}</p>
          </div>

          <Field label="Novo dono" hint="Endereço de conta (G…) ou de contrato (C…).">
            <Input
              className="font-mono text-xs"
              placeholder="C… ou G…"
              value={transferTo}
              onChange={(event) => setTransferTo(event.target.value.trim())}
              spellCheck={false}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

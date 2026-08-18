// Mint com campos livres + o ledger resultante.
//
// É o caso de uso que fecha o circuito: o usuário preenche um formulário, a
// passkey assina, o relayer paga a taxa, o contrato guarda os campos e o
// registro aparece no ledger — sem seed phrase e sem XLM para a fee.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, Layers, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  Field,
  Input,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { CONFIG, contractUrl, txUrl } from '@/lib/config';
import { kit } from '@/lib/kit';
import {
  LIMITS,
  cleanFields,
  mintRecord,
  validateMint,
  type CustomField,
} from '@/lib/mint';
import { truncateAddress } from '@/lib/utils';

interface LedgerRecord {
  id: number;
  owner: string;
  name: string;
  uri: string;
  fields: Record<string, string>;
  mintedAt: number;
  mintedLedger: number;
}

const SUGGESTIONS: CustomField[] = [
  { key: 'campanha', value: '' },
  { key: 'lote', value: '' },
  { key: 'serie', value: '' },
];

export function MintPage({ address }: { address: string }) {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [uri, setUri] = useState('');
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

  const input = { name, uri, fields: cleanFields(fields) };
  const validationError = validateMint({ name, uri, fields });

  const mint = useMutation({
    mutationFn: async () => {
      const result = await mintRecord(kit, address, input);
      if (!result.success) {
        throw new Error(result.error?.message ?? 'O contrato recusou o mint.');
      }
      return result;
    },
    onSuccess: (result) => {
      toast.success('Registrado no ledger.', {
        action: result.hash
          ? { label: 'Ver transação', onClick: () => window.open(txUrl(result.hash!), '_blank') }
          : undefined,
      });
      setName('');
      setUri('');
      setFields([
        { key: '', value: '' },
        { key: '', value: '' },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['ledger'] });
      void queryClient.invalidateQueries({ queryKey: ['usage', address] });
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
          banco de dados. Cada registro vira uma entrada numerada e imutável no ledger, com evento
          on-chain — e a taxa é paga pelo sponsor.
        </p>

        <div className="space-y-4">
          <Field label="Nome do item" hint={`Até ${LIMITS.maxNameLen} caracteres.`}>
            <Input
              value={name}
              maxLength={LIMITS.maxNameLen}
              placeholder="Ingresso VIP — Turnê 2026"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field label="URI da mídia" hint="Opcional. ipfs://… ou https://…">
            <Input
              value={uri}
              maxLength={LIMITS.maxUriLen}
              placeholder="ipfs://Qm…"
              onChange={(event) => setUri(event.target.value)}
              spellCheck={false}
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
              <li key={record.id} className="py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="muted">#{record.id}</Badge>
                  <p className="flex-1 truncate text-sm font-medium text-fg">{record.name}</p>
                  {record.owner === address && <Badge tone="primary">seu</Badge>}
                </div>

                <p className="mt-1 font-mono text-xs text-muted">
                  {truncateAddress(record.owner, 6, 4)} · ledger {record.mintedLedger}
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

                {record.uri && (
                  <p className="mt-1 truncate font-mono text-xs text-muted">{record.uri}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

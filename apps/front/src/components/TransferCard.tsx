// A prova de que o patrocínio funciona: uma transferência real em que o
// usuário não paga taxa e nem precisa ter XLM para a fee.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { Button, Card, CardTitle, Field, Input } from '@/components/ui';
import { CONFIG, txUrl } from '@/lib/config';
import { kit } from '@/lib/kit';

const DEMO_RECIPIENT = 'GBKMZQWUCKIGARWNLOQFFMWUJSTY6FAIDT73EZOQK5A5HFGXBBSBE72Z';

const ERROR_COPY: Record<string, string> = {
  FEE_LIMIT_EXCEEDED: 'Cota diária de taxas esgotada.',
  UNAUTHORIZED: 'Este contrato não é patrocinável por este app.',
  ALLOWLIST_EMPTY: 'Nenhum contrato-alvo configurado para patrocínio.',
  NO_CHANNEL_AVAILABLE: 'Todas as contas pagadoras estão ocupadas. Tente em instantes.',
};

export function TransferCard({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('1');
  const [recipient, setRecipient] = useState(DEMO_RECIPIENT);

  const transfer = useMutation({
    mutationFn: async () => {
      const result = await kit.transfer(CONFIG.xlmSacAddress, recipient, Number(amount));
      if (!result.success) {
        const error = (result as unknown as { error?: { code?: string; message?: string } }).error;
        throw Object.assign(new Error(error?.message ?? 'Transferência recusada'), {
          code: error?.code,
        });
      }
      return result;
    },
    onSuccess: (result) => {
      toast.success('Enviado — a taxa foi por nossa conta.', {
        action: result.hash
          ? { label: 'Ver transação', onClick: () => window.open(txUrl(result.hash!), '_blank') }
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['usage', address] });
      void queryClient.invalidateQueries({ queryKey: ['account', address] });
    },
    onError: (error: Error & { code?: string }) => {
      toast.error(ERROR_COPY[error.code ?? ''] ?? error.message);
      void queryClient.invalidateQueries({ queryKey: ['usage', address] });
    },
  });

  const valid = Number(amount) > 0 && /^G[A-Z2-7]{55}$/.test(recipient);

  return (
    <Card>
      <CardTitle>Testar transferência patrocinada</CardTitle>

      <div className="space-y-3">
        <Field label="Valor (XLM)">
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>

        <Field label="Destinatário" hint="Conta clássica (G…)">
          <Input
            className="font-mono text-xs"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value.trim())}
            spellCheck={false}
          />
        </Field>

        <Button
          full
          loading={transfer.isPending}
          disabled={!valid}
          onClick={() => transfer.mutate()}
        >
          {!transfer.isPending && <Send className="size-4" />}
          {transfer.isPending ? 'Assinando com a passkey…' : 'Enviar (taxa por nossa conta)'}
        </Button>
      </div>
    </Card>
  );
}

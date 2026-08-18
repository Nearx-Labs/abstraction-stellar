// O faucet de testnet. Duas pernas, uma ação: XLM na conta e cota de taxas
// ativada no Treasury. A tela mostra as duas porque só a primeira dá saldo — é
// a segunda que faz o patrocínio funcionar.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Droplets, ExternalLink } from 'lucide-react';
import { Alert, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { ApiError, endpoints } from '@/lib/api';
import { txUrl } from '@/lib/config';
import { formatDuration, formatXlm } from '@/lib/utils';

const ERROR_COPY: Record<string, string> = {
  FAUCET_COOLDOWN: 'Você já usou o faucet nas últimas 24h.',
  FAUCET_DRY: 'O faucet está sem saldo. Avisamos a equipe.',
  FAUCET_IN_FLIGHT: 'Já tem um pedido em andamento. Aguarde alguns segundos.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde um minuto.',
  ACCOUNT_NOT_DEPLOYED: 'Sua conta ainda está sendo implantada. Aguarde alguns segundos.',
  FAUCET_FAILED: 'Não deu para enviar o XLM agora. Tente de novo.',
};

function useCountdown(target: string | null): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!target) {
      setSeconds(0);
      return;
    }
    const update = () =>
      setSeconds(Math.max(0, Math.floor((new Date(target).getTime() - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [target]);

  return seconds;
}

export function FaucetCard({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const [justSucceeded, setJustSucceeded] = useState(false);

  const { data: status, isPending } = useQuery({
    queryKey: ['faucet', address],
    queryFn: () => endpoints.faucetStatus(address),
    // Enquanto a perna da allowance não fecha, vale acompanhar.
    refetchInterval: (query) =>
      query.state.data?.last?.state === 'allowance_set' ||
      query.state.data?.last?.state === 'xlm_sent'
        ? 4_000
        : 60_000,
  });

  const remaining = useCountdown(status?.blocked ? status.nextAvailableAt : null);

  const claim = useMutation({
    mutationFn: () => endpoints.claimFaucet(address),
    onSuccess: (result) => {
      setJustSucceeded(true);
      setTimeout(() => setJustSucceeded(false), 4000);
      toast.success('XLM na conta. Registrando seu limite de taxas no Treasury.', {
        action: result.xlmTxHash
          ? { label: 'Ver transação', onClick: () => window.open(txUrl(result.xlmTxHash!), '_blank') }
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['faucet', address] });
      void queryClient.invalidateQueries({ queryKey: ['account', address] });
      void queryClient.invalidateQueries({ queryKey: ['usage', address] });
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : 'UNKNOWN';
      toast.error(ERROR_COPY[code] ?? 'Não deu certo agora. Tente de novo em instantes.');
      void queryClient.invalidateQueries({ queryKey: ['faucet', address] });
    },
  });

  const retryAllowance = useMutation({
    mutationFn: () => endpoints.retryAllowance(address),
    onSuccess: () => {
      toast.success('Registro do limite reenviado.');
      void queryClient.invalidateQueries({ queryKey: ['faucet', address] });
    },
    onError: () => toast.error('Não deu para reenviar agora.'),
  });

  if (isPending || !status) {
    return (
      <Card>
        <CardTitle>Faucet de testnet</CardTitle>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-4 h-12 w-full" />
      </Card>
    );
  }

  const amount = formatXlm(status.amountStroops, 0);
  const last = status.last;
  // A perna do XLM passou, mas a cota não fechou: dá para reenviar só ela.
  const partial = last?.state === 'xlm_sent' || last?.state === 'allowance_set';

  return (
    <Card>
      <CardTitle>Faucet de testnet</CardTitle>

      <p className="mb-4 text-sm text-muted">
        Recebe {amount} XLM de teste e registra seu limite de taxas patrocinadas no
        contrato Treasury.
      </p>

      {claim.isPending && (
        <ol className="mb-4 space-y-2 text-sm">
          <li className="flex items-center gap-2 text-muted">
            <span className="text-primary">①</span> Enviando {amount} XLM…
          </li>
          <li className="flex items-center gap-2 text-muted/60">
            <span>②</span> Registrando seu limite de taxas no Treasury
          </li>
        </ol>
      )}

      {justSucceeded ? (
        <Button full size="lg" disabled>
          <Check className="size-4" /> Recebido
        </Button>
      ) : status.blocked ? (
        <Button full size="lg" variant="outline" disabled>
          Disponível em {formatDuration(remaining)}
        </Button>
      ) : (
        <Button
          full
          size="lg"
          loading={claim.isPending}
          onClick={() => claim.mutate()}
        >
          {!claim.isPending && <Droplets className="size-4" />}
          {claim.isPending ? 'Enviando…' : `Receber ${amount} XLM de teste`}
        </Button>
      )}

      <p className="mt-3 text-center text-xs text-muted">
        {status.blocked
          ? 'Você já recebeu hoje.'
          : `Disponível 1x a cada ${status.cooldownHours}h.`}
      </p>

      {last?.xlmTxHash && (
        <a
          href={txUrl(last.xlmTxHash)}
          target="_blank"
          rel="noopener"
          className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Ver última transação <ExternalLink className="size-3" />
        </a>
      )}

      {partial && !claim.isPending && (
        <div className="mt-4">
          <Alert
            action={
              <Button
                size="sm"
                variant="outline"
                loading={retryAllowance.isPending}
                onClick={() => retryAllowance.mutate()}
              >
                Registrar limite
              </Button>
            }
          >
            {amount} XLM enviados, mas o limite de taxas ainda não foi registrado no
            Treasury — sem ele, o gasto patrocinado não fica auditável on-chain.
          </Alert>
        </div>
      )}

      {last?.state === 'failed' && last.error && (
        <div className="mt-4">
          <Alert tone="danger" title="A última tentativa falhou.">
            Você pode tentar de novo — o cooldown não conta tentativa que falhou.
          </Alert>
        </div>
      )}
    </Card>
  );
}

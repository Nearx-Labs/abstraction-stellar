import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, ExternalLink, Fingerprint } from 'lucide-react';
import { Alert, Button, Card } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { DEPLOYED_CONTRACTS, contractUrl } from '@/lib/config';
import { truncateAddress } from '@/lib/utils';

const STAGE_LABEL: Record<string, string> = {
  webauthn: 'Aguardando sua digital…',
  deploying: 'Implantando sua conta na rede…',
  registering: 'Quase lá…',
};

export function Onboarding() {
  const { stage, createWallet, connectWallet, registrationPending, retryRegistration } =
    useWallet();
  const navigate = useNavigate();
  const [showContracts, setShowContracts] = useState(false);

  const busy = stage === 'webauthn' || stage === 'deploying' || stage === 'registering';

  async function run(action: () => Promise<void>, successMessage: string) {
    try {
      await action();
      toast.success(successMessage);
      navigate('/wallet');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não deu certo agora.');
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-3 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/12">
          <Fingerprint className="size-7 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Sua conta Stellar sem seed phrase
        </h1>
        <p className="text-sm text-muted">
          Entre com a digital do seu device. Nós pagamos as taxas.
        </p>
      </div>

      <Card className="space-y-3">
        {registrationPending && (
          <Alert
            title="Conta criada, mas o registro no painel falhou."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(retryRegistration, 'Registro concluído.')
                }
              >
                Reenviar registro
              </Button>
            }
          >
            Sua conta já existe na rede — só o painel não soube dela. Dá para tentar de novo.
          </Alert>
        )}

        <Button
          full
          size="lg"
          loading={busy}
          onClick={() => run(createWallet, 'Conta criada. Bem-vindo.')}
        >
          {busy ? (STAGE_LABEL[stage] ?? 'Criando…') : 'Criar conta com passkey'}
        </Button>

        {stage === 'deploying' && (
          <p className="text-center text-xs text-muted">
            Isso leva ~10 segundos. A taxa é por nossa conta.
          </p>
        )}

        <Button
          full
          variant="ghost"
          disabled={busy}
          onClick={() => run(connectWallet, 'Bem-vindo de volta.')}
        >
          Já tenho uma conta
        </Button>
      </Card>

      <footer className="space-y-3 text-center">
        <p className="text-xs text-muted">Testnet · Protocolo 27</p>

        <button
          onClick={() => setShowContracts((open) => !open)}
          className="mx-auto flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg"
        >
          Contratos implantados
          <ChevronDown
            className={`size-3.5 transition-transform ${showContracts ? 'rotate-180' : ''}`}
          />
        </button>

        {showContracts && (
          <ul className="space-y-1.5 rounded-xl border border-border bg-surface p-3 text-left">
            {DEPLOYED_CONTRACTS.map(([label, address]) => (
              <li key={address} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted">{label}</span>
                <a
                  href={contractUrl(address)}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                >
                  {truncateAddress(address, 6, 4)}
                  <ExternalLink className="size-3" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </footer>
    </main>
  );
}

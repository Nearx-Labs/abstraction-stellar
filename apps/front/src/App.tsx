import { Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Layout } from '@/components/Layout';
import { Onboarding } from '@/pages/Onboarding';
import { WalletPage } from '@/pages/Wallet';
import { SessionsPage } from '@/pages/Sessions';
import { MintPage } from '@/pages/Mint';
import { useWallet } from '@/hooks/useWallet';

function Protected({ render }: { render: (address: string) => JSX.Element }) {
  const { contractId, stage } = useWallet();

  if (stage === 'restoring') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted" />
      </div>
    );
  }
  if (!contractId) return <Navigate to="/" replace />;

  return <Layout address={contractId}>{render(contractId)}</Layout>;
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route
          path="/wallet"
          element={<Protected render={(address) => <WalletPage address={address} />} />}
        />
        <Route
          path="/mint"
          element={<Protected render={(address) => <MintPage address={address} />} />}
        />
        <Route
          path="/sessions"
          element={<Protected render={(address) => <SessionsPage address={address} />} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster richColors position="top-right" theme="dark" />
    </>
  );
}

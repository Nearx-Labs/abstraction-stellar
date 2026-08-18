import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { WalletProvider } from './hooks/useWallet';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Leituras on-chain custam simulação: não vale refazer a cada foco.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <WalletProvider>
          <App />
        </WalletProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Estado da carteira: criar, conectar, restaurar, sair.
//
// Restaurar a sessão do kit (IndexedDB) não basta — o painel também precisa do
// cookie httpOnly. Por isso o `connect` sempre passa pela assertion de passkey.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { APP_NAME } from '@/lib/config';
import { kit, normalizeCreated, openPanelSession } from '@/lib/kit';
import { endpoints } from '@/lib/api';
import { restoreSessions } from '@/lib/session';

export type WalletStage =
  | 'idle'
  | 'restoring'
  | 'webauthn'
  | 'deploying'
  | 'registering'
  | 'ready';

interface WalletState {
  contractId: string | null;
  stage: WalletStage;
  /** Conta criada on-chain mas não registrada no painel — dá para reenviar. */
  registrationPending: boolean;
  createWallet: () => Promise<void>;
  connectWallet: () => Promise<void>;
  retryRegistration: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [contractId, setContractId] = useState<string | null>(null);
  const [stage, setStage] = useState<WalletStage>('restoring');
  const [registrationPending, setRegistrationPending] = useState(false);
  const [pendingRegistration, setPendingRegistration] = useState<{
    contractId: string;
    credentialId?: string;
    publicKeyHex?: string;
  } | null>(null);

  // Restaura a conta guardada pelo kit; a sessão do painel vem depois, no
  // primeiro toque na passkey.
  useEffect(() => {
    let cancelled = false;
    kit
      .connectWallet()
      .then((restored) => {
        if (cancelled) return;
        if (restored?.contractId) {
          setContractId(restored.contractId);
          // Recarrega no kit as chaves de grant guardadas neste navegador —
          // é o que faz um grant sem prazo continuar utilizável após reload.
          restoreSessions(kit, restored.contractId);
        }
        setStage('idle');
      })
      .catch(() => {
        if (!cancelled) setStage('idle');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(
    async (payload: { contractId: string; credentialId?: string; publicKeyHex?: string }) => {
      await endpoints.registerAccount(payload);
      await openPanelSession(payload.contractId);
      setPendingRegistration(null);
      setRegistrationPending(false);
    },
    [],
  );

  const createWallet = useCallback(async () => {
    setStage('webauthn');
    try {
      // O kit faz a cerimônia WebAuthn e, logo depois, o deploy patrocinado.
      const raw = (await kit.createWallet(APP_NAME, 'criador', {
        autoSubmit: true,
      })) as unknown as Record<string, unknown>;
      setStage('deploying');

      const created = normalizeCreated(raw);
      setContractId(created.contractId);
      setStage('registering');

      try {
        await register(created);
      } catch (error) {
        // A conta existe on-chain; só o registro falhou. O usuário não pode
        // ficar preso por causa disso.
        setPendingRegistration(created);
        setRegistrationPending(true);
        throw error;
      }
      setStage('ready');
    } catch (error) {
      setStage('idle');
      throw error;
    }
  }, [register]);

  const connectWallet = useCallback(async () => {
    setStage('webauthn');
    try {
      const result = await kit.connectWallet({ prompt: true });
      if (!result?.contractId) throw new Error('Nenhuma conta encontrada para esta passkey.');
      setContractId(result.contractId);
      restoreSessions(kit, result.contractId);
      await openPanelSession(result.contractId);
      setStage('ready');
    } catch (error) {
      setStage('idle');
      throw error;
    }
  }, []);

  const retryRegistration = useCallback(async () => {
    if (!pendingRegistration) return;
    await register(pendingRegistration);
  }, [pendingRegistration, register]);

  const disconnect = useCallback(async () => {
    await endpoints.logout().catch(() => {});
    await kit.disconnect();
    setContractId(null);
    setStage('idle');
  }, []);

  const value = useMemo(
    () => ({
      contractId,
      stage,
      registrationPending,
      createWallet,
      connectWallet,
      retryRegistration,
      disconnect,
    }),
    [
      contractId,
      stage,
      registrationPending,
      createWallet,
      connectWallet,
      retryRegistration,
      disconnect,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet precisa estar dentro de WalletProvider');
  return context;
}

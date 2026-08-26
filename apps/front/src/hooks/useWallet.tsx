// Estado da carteira: criar, conectar, restaurar, sair.
//
// Restaurar a sessão do kit (IndexedDB) não basta — o painel também precisa do
// cookie httpOnly. Por isso o `connect` sempre passa pela assertion de passkey.
//
// Dois modos de entrar, e a diferença importa para o que a tela pode oferecer:
//
//   · PASSKEY — o browser controla a chave. Dá para assinar: criar regra,
//     revogar, transferir.
//   · SENHA — a conta é custodial, provisionada pelo serviço com chave
//     derivada. O browser não tem chave nenhuma; assinar é impossível aqui, e
//     quem opera em nome da conta é o serviço. `custodial` sinaliza isso para
//     as telas não oferecerem um botão que não funcionaria.
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
  /** Sessão aberta por senha: o browser não controla a chave desta conta. */
  custodial: boolean;
  /** Conta criada on-chain mas não registrada no painel — dá para reenviar. */
  registrationPending: boolean;
  createWallet: () => Promise<void>;
  connectWallet: () => Promise<void>;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  retryRegistration: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [contractId, setContractId] = useState<string | null>(null);
  const [stage, setStage] = useState<WalletStage>('restoring');
  const [custodial, setCustodial] = useState(false);
  const [registrationPending, setRegistrationPending] = useState(false);
  const [pendingRegistration, setPendingRegistration] = useState<{
    contractId: string;
    credentialId?: string;
    publicKeyHex?: string;
  } | null>(null);

  // Restauração no boot, nesta ordem:
  //
  //  1. o kit (IndexedDB) — conta com passkey neste navegador;
  //  2. o cookie de sessão — conta custodial, onde o browser não guarda nada e
  //     o cookie httpOnly é toda a memória que existe.
  //
  // Sem o passo 2, recarregar a página numa sessão custodial jogava o usuário
  // de volta para a tela de login com a sessão ainda válida.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const restored = await kit.connectWallet();
        if (cancelled) return;
        if (restored?.contractId) {
          setContractId(restored.contractId);
          // Recarrega no kit as chaves de grant guardadas neste navegador —
          // é o que faz um grant sem prazo continuar utilizável após reload.
          restoreSessions(kit, restored.contractId);
          setStage('idle');
          return;
        }
      } catch {
        // sem conta local; tenta o cookie abaixo
      }

      try {
        const session = await endpoints.session();
        if (cancelled) return;
        setContractId(session.contractId);
        setCustodial(session.custodial);
      } catch {
        // sem sessão: cai na tela de login, que é o certo
      }

      if (!cancelled) setStage('idle');
    })();

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
      setCustodial(false);
      restoreSessions(kit, result.contractId);
      await openPanelSession(result.contractId);
      setStage('ready');
    } catch (error) {
      setStage('idle');
      throw error;
    }
  }, []);

  /**
   * Entra na conta custodial. Sem kit e sem IndexedDB: não há chave para
   * guardar deste lado — o cookie httpOnly é toda a sessão.
   */
  const loginWithPassword = useCallback(async (email: string, password: string) => {
    setStage('registering');
    try {
      const result = await endpoints.password(email, password);
      setContractId(result.contractId);
      setCustodial(true);
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
    // Numa sessão custodial o kit nunca guardou nada; `disconnect` seria no-op,
    // mas chamá-lo apagaria a passkey de quem alterna entre os dois modos.
    if (!custodial) await kit.disconnect();
    setContractId(null);
    setCustodial(false);
    setStage('idle');
  }, [custodial]);

  const value = useMemo(
    () => ({
      contractId,
      stage,
      custodial,
      registrationPending,
      createWallet,
      connectWallet,
      loginWithPassword,
      retryRegistration,
      disconnect,
    }),
    [
      contractId,
      stage,
      custodial,
      registrationPending,
      createWallet,
      connectWallet,
      loginWithPassword,
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

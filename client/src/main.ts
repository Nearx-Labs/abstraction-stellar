import { SmartAccountKit, IndexedDBStorage } from 'smart-account-kit';
import { APP_NAME, TESTNET_CONFIG } from './config';

const statusEl = document.getElementById('status')!;
const createBtn = document.getElementById('create') as HTMLButtonElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;

const kit = new SmartAccountKit({
  rpcUrl: TESTNET_CONFIG.rpcUrl,
  networkPassphrase: TESTNET_CONFIG.networkPassphrase,
  accountWasmHash: TESTNET_CONFIG.accountWasmHash,
  webauthnVerifierAddress: TESTNET_CONFIG.webauthnVerifierAddress,
  ed25519VerifierAddress: TESTNET_CONFIG.ed25519VerifierAddress,
  relayerUrl: TESTNET_CONFIG.relayerUrl,
  rpName: APP_NAME,
  storage: new IndexedDBStorage(),
});

function setStatus(text: string) {
  statusEl.textContent = text;
}

function setConnected(contractId: string) {
  setStatus(`Conectado.\n\nSmart account:\n${contractId}\n\nRede: testnet`);
  createBtn.hidden = true;
  connectBtn.hidden = true;
  disconnectBtn.hidden = false;
}

function setDisconnected() {
  setStatus('Desconectado.');
  createBtn.hidden = false;
  connectBtn.hidden = false;
  disconnectBtn.hidden = true;
}

createBtn.addEventListener('click', async () => {
  try {
    setStatus('Criando passkey e implantando a smart account…');
    const { contractId } = await kit.createWallet(APP_NAME, 'usuario', {
      autoSubmit: true,
    });
    setConnected(contractId);
  } catch (err) {
    setStatus(`Erro ao criar conta: ${err instanceof Error ? err.message : err}`);
  }
});

connectBtn.addEventListener('click', async () => {
  try {
    setStatus('Aguardando passkey…');
    const result = await kit.connectWallet({ prompt: true });
    if (result) {
      setConnected(result.contractId);
    } else {
      setStatus('Nenhuma conta encontrada para esta passkey.');
    }
  } catch (err) {
    setStatus(`Erro ao conectar: ${err instanceof Error ? err.message : err}`);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await kit.disconnect();
  setDisconnected();
});

// Restaura sessão persistida ao carregar a página.
kit.connectWallet().then((restored) => {
  if (restored) setConnected(restored.contractId);
});

import { SmartAccountKit, IndexedDBStorage } from 'smart-account-kit';
import { APP_NAME, TESTNET_CONFIG } from './config';

const statusEl = document.getElementById('status')!;
const createBtn = document.getElementById('create') as HTMLButtonElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;

// Destinatário do demo (a conta "demo" do stellar CLI).
const DEMO_RECIPIENT = 'GBKMZQWUCKIGARWNLOQFFMWUJSTY6FAIDT73EZOQK5A5HFGXBBSBE72Z';

const EXPLORER = 'https://stellar.expert/explorer/testnet';

function link(href: string, label: string): string {
  return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
}

const contractLink = (addr: string, label = addr) => link(`${EXPLORER}/contract/${addr}`, label);
const txLink = (hash: string) => link(`${EXPLORER}/tx/${hash}`, hash);

// Rodapé com todos os contratos implantados, clicáveis.
document.getElementById('contracts-list')!.innerHTML = (
  [
    ['Treasury (paymaster)', TESTNET_CONFIG.treasuryContractId],
    ['WebAuthn verifier (passkeys)', TESTNET_CONFIG.webauthnVerifierAddress],
    ['Ed25519 verifier (session keys)', TESTNET_CONFIG.ed25519VerifierAddress],
    ['Email attestation verifier', TESTNET_CONFIG.emailVerifierAddress],
    ['Spending-limit policy', TESTNET_CONFIG.spendingLimitPolicyAddress],
  ] as const
)
  .map(([label, addr]) => `<li>${label}: ${contractLink(addr, addr.slice(0, 8) + '…')}</li>`)
  .join('');

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

// Conteúdo montado apenas com constantes locais + hashes retornados pela
// rede — nunca input livre do usuário.
function setStatusHtml(html: string) {
  statusEl.innerHTML = html;
}

function setConnected(contractId: string) {
  setStatusHtml(
    `Conectado.\n\nSmart account:\n${contractLink(contractId)}\n\nRede: testnet`,
  );
  createBtn.hidden = true;
  connectBtn.hidden = true;
  sendBtn.hidden = false;
  disconnectBtn.hidden = false;
}

function setDisconnected() {
  setStatus('Desconectado.');
  createBtn.hidden = false;
  connectBtn.hidden = false;
  sendBtn.hidden = true;
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

sendBtn.addEventListener('click', async () => {
  try {
    setStatus('Assinando com a passkey e submetendo via relayer patrocinado…');
    const result = await kit.transfer(TESTNET_CONFIG.xlmSacAddress, DEMO_RECIPIENT, 1);
    if (result.success) {
      setStatusHtml(
        `✅ 1 XLM enviado — fee paga pelo sponsor, não pelo usuário.\n\n` +
          `Transação:\n${result.hash ? txLink(result.hash) : '(via relayer)'}\n\n` +
          `Débito auditável no Treasury:\n` +
          `${contractLink(TESTNET_CONFIG.treasuryContractId)}`,
      );
    } else {
      setStatus(`Transferência recusada: [${result.error.code}] ${result.error.message}`);
    }
  } catch (err) {
    setStatus(`Erro na transferência: ${err instanceof Error ? err.message : err}`);
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

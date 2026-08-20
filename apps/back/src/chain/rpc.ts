import { rpc } from '@stellar/stellar-sdk';
import { env } from '../env.js';

export const NETWORK_PASSPHRASE = env.NETWORK_PASSPHRASE;
export const RPC_URL = env.RPC_URL;

export const server = new rpc.Server(RPC_URL);

/** Ledger atual — usado para converter `valid_until` de ledger para relógio. */
export async function currentLedger(): Promise<number> {
  const { sequence } = await server.getLatestLedger();
  return sequence;
}

/** ~5s por ledger no protocolo atual. */
export const LEDGER_SECONDS = 5;

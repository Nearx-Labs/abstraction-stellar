import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const STROOPS_PER_XLM = 10_000_000n;

/** Formata stroops como XLM, com 7 casas e vírgula decimal (pt-BR). */
export function formatXlm(stroops: bigint | string | null | undefined, decimals = 4): string {
  if (stroops === null || stroops === undefined) return '—';
  const value = typeof stroops === 'string' ? BigInt(stroops) : stroops;
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = (abs / STROOPS_PER_XLM).toLocaleString('pt-BR');
  if (decimals <= 0) return `${negative ? '-' : ''}${whole}`;

  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole},${frac}`;
}

export function xlmToStroops(xlm: string): bigint {
  const [whole = '0', frac = ''] = xlm.replace(',', '.').split('.');
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(7, '0').slice(0, 7));
}

export function truncateAddress(address: string, head = 8, tail = 5): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** "2h 14min", "42min", "em instantes" — para contadores regressivos. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'agora';
  if (seconds < 60) return 'em instantes';

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

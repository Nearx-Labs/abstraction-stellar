import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { ExternalLink, KeyRound, LogOut, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { cn, truncateAddress } from '@/lib/utils';
import { contractUrl } from '@/lib/config';
import { useWallet } from '@/hooks/useWallet';

const TABS = [
  { to: '/wallet', label: 'Carteira', icon: Wallet },
  { to: '/mint', label: 'Mint', icon: Sparkles },
  { to: '/master', label: 'Conta mestre', icon: ShieldCheck },
  { to: '/sessions', label: 'Session keys', icon: KeyRound },
];

export function Layout({ address, children }: { address: string; children: ReactNode }) {
  const { disconnect } = useWallet();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <span className="text-sm font-semibold tracking-tight text-fg">Abstraction</span>

          <div className="relative">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-xs transition-colors hover:bg-surface-2"
            >
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              <span className="font-mono">{truncateAddress(address, 6, 4)}</span>
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full z-30 mt-2 w-52 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
                  <a
                    href={contractUrl(address)}
                    target="_blank"
                    rel="noopener"
                    className="flex items-center gap-2 px-3 py-2.5 text-sm text-fg transition-colors hover:bg-surface-2"
                  >
                    <ExternalLink className="size-4 text-muted" /> Ver no explorer
                  </a>
                  <button
                    onClick={async () => {
                      setMenuOpen(false);
                      await disconnect();
                      navigate('/');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-fg transition-colors hover:bg-surface-2"
                  >
                    <LogOut className="size-4 text-muted" /> Sair
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <nav className="mx-auto flex max-w-3xl gap-1 px-4 pb-2">
          {TABS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                  isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">{children}</main>
    </div>
  );
}

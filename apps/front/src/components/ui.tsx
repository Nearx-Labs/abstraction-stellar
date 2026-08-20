// Primitivas de UI. Escritas à mão em vez de puxar uma biblioteca de
// componentes: são oito peças, todas simples, e assim o bundle não carrega
// nada que a tela não usa.
import { forwardRef, useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Button ──────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-fg hover:bg-primary/90 active:bg-primary-dim disabled:bg-primary/40',
  outline: 'border border-border bg-transparent text-fg hover:bg-surface-2',
  ghost: 'bg-transparent text-muted hover:text-fg hover:bg-surface-2',
  danger: 'border border-danger/50 bg-transparent text-danger hover:bg-danger/10',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, full, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium',
        'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        'disabled:cursor-not-allowed disabled:opacity-70',
        VARIANTS[variant],
        SIZES[size],
        full && 'w-full',
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

// ── Card ────────────────────────────────────────────────────────────────────

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        'rounded-[var(--radius-card)] border border-border bg-surface p-5 sm:p-6',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {action}
    </header>
  );
}

// ── Input ───────────────────────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg',
          'placeholder:text-muted/60 outline-none',
          'focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/25',
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
      {error ? (
        <span className="block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

// ── Progress ────────────────────────────────────────────────────────────────

export function Progress({ value, tone = 'primary' }: { value: number; tone?: Variant | 'warning' }) {
  const clamped = Math.min(Math.max(value, 0), 100);
  const color =
    tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-primary';
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', color)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────

const BADGE_TONES = {
  primary: 'bg-primary/12 text-primary',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  muted: 'bg-surface-2 text-muted',
} as const;

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'primary' }: { tone?: keyof typeof BADGE_TONES }) {
  const color =
    tone === 'danger'
      ? 'bg-danger'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'muted'
          ? 'bg-muted'
          : 'bg-primary';
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} aria-hidden />;
}

// ── Alert ───────────────────────────────────────────────────────────────────

export function Alert({
  tone = 'warning',
  title,
  children,
  action,
}: {
  tone?: 'warning' | 'danger' | 'primary';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    warning: 'border-warning/30 bg-warning/8 text-warning',
    danger: 'border-danger/30 bg-danger/8 text-danger',
    primary: 'border-primary/30 bg-primary/8 text-primary',
  }[tone];

  return (
    <div className={cn('rounded-xl border p-3.5 text-sm', styles)}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="text-fg/85">{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg', className)} aria-hidden />;
}

// ── Modal ───────────────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative w-full max-w-lg rounded-t-[var(--radius-card)] sm:rounded-[var(--radius-card)]',
          'border border-border bg-surface p-5 sm:p-6 shadow-2xl',
          'max-h-[90dvh] overflow-y-auto',
        )}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </header>
        {children}
        {footer && <footer className="mt-6 flex gap-2">{footer}</footer>}
      </div>
    </div>
  );
}

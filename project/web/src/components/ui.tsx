import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { MemoryStatus } from '@cogeto/shared';
import { STATUS_META, TONE_CLASS } from './status';
import type { Tone } from './status';

/**
 * The canonical UI kit (O3-C). One home for chips, badges, buttons, cards,
 * states, and the drawer — so the whole app reads as one system and status
 * color (load-bearing information) is defined once, AA-verified, never drifts.
 * Every chip carries a text label (and often an icon): nothing is color-only.
 */

const BADGE = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold';

// ── Status + tone chips ──────────────────────────────────────────────────────
export function StatusChip({
  status,
  className = '',
}: {
  status: MemoryStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span className={`${BADGE} ${meta.className} ${className}`} title={meta.label}>
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

/** Generic tone pill for the adjacent concepts (health, file-state, verdict, …). */
export function Pill({
  tone,
  icon,
  children,
  className = '',
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`${BADGE} ${TONE_CLASS[tone]} ${className}`}>
      {icon != null && <span aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}

export function SensitiveBadge() {
  return (
    <span
      className={`${BADGE} bg-violet-100 text-violet-700`}
      title="Sensitive — owner-only, off by default in retrieval"
    >
      <span aria-hidden="true">🔒</span>sensitive
    </span>
  );
}

export function SharedBadge({ owner }: { owner?: string | null }) {
  return (
    <span className={`${BADGE} bg-sky-100 text-sky-700`} title="Visible to your whole organization">
      <span aria-hidden="true">◇</span>shared{owner ? ` · ${owner}` : ''}
    </span>
  );
}

/** Private scope reads as a quiet tag, not a loud chip (it's the default). */
export function PrivateTag() {
  return <span className="text-xs text-slate-400">private</span>;
}

export function DormantBadge() {
  return (
    <span
      className={`${BADGE} bg-slate-100 text-slate-600`}
      title="No activity for a while — gone quiet"
    >
      <span aria-hidden="true">☾</span>gone quiet
    </span>
  );
}

/** Entity tag. A button when filterable, a plain span otherwise. */
export function EntityChip({ name, onClick }: { name: string; onClick?: () => void }) {
  const cls = 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600';
  return onClick ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${cls} hover:bg-slate-200`}
      title={`Filter by ${name}`}
    >
      {name}
    </button>
  ) : (
    <span className={cls}>{name}</span>
  );
}

/** Verification verdict (§B.3) → tone. */
export function VerdictChip({ verdict }: { verdict: string }) {
  const tone: Tone =
    verdict === 'supported' ? 'positive' : verdict === 'unsupported' ? 'danger' : 'warning';
  const icon = verdict === 'supported' ? '✓' : verdict === 'unsupported' ? '✕' : '≈';
  return (
    <Pill tone={tone} icon={icon}>
      {verdict}
    </Pill>
  );
}

/** Notification count for nav/tabs — with an accessible label. */
export function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      className="rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900"
      aria-label={`${count} ${label}`}
    >
      {count}
    </span>
  );
}

// ── Buttons (class constants keep call sites lightweight) ────────────────────
export const btnPrimary =
  'inline-flex items-center gap-1.5 rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-teal-ink disabled:opacity-40';
export const btnSecondary =
  'inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40';
export const btnDanger =
  'inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40';

// ── Cards + section headings ─────────────────────────────────────────────────
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({
  children,
  as: As = 'h2',
}: {
  children: ReactNode;
  as?: 'h2' | 'h3';
}) {
  return (
    <As className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</As>
  );
}

// ── States: empty (teaching), error (never blame), skeleton (loading) ────────
export function EmptyState({
  icon,
  title,
  children,
  action,
  tone = 'neutral',
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** `positive` for accomplishment zero-states (an empty queue is a good thing). */
  tone?: 'neutral' | 'positive';
}) {
  return (
    <section
      className={`rounded-lg border border-dashed p-8 text-center ${
        tone === 'positive' ? 'border-brand-teal/40 bg-brand-teal-surface/40' : 'border-slate-300'
      }`}
    >
      {icon != null && (
        <div
          className={`mx-auto mb-2 text-2xl ${tone === 'positive' ? 'text-brand-teal-ink' : 'text-slate-400'}`}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </section>
  );
}

export function ErrorState({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`${btnSecondary} ml-auto`}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

/** A few skeleton lines standing in for text/rows that are loading. */
export function SkeletonRows({ rows = 3, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`h-10 ${i === rows - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: ReactNode }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex w-fit gap-1 rounded-lg bg-slate-200/70 p-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
            active === t.key
              ? 'bg-white text-slate-800 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Drawer (shared overlay: dialog semantics, Escape, focus, motion) ─────────
// Module-level stack so Escape closes only the top-most drawer when nested
// (the source drawer over the memory drawer).
const drawerStack: (() => void)[] = [];

export function Drawer({
  title,
  onClose,
  children,
  width = 'max-w-lg',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const close = () => onClose();
    drawerStack.push(close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawerStack[drawerStack.length - 1] === close) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const idx = drawerStack.indexOf(close);
      if (idx >= 0) drawerStack.splice(idx, 1);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-20">
      <div className="absolute inset-0 bg-slate-900/30" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`absolute right-0 top-0 flex h-full w-full ${width} animate-drawer-in flex-col bg-white shadow-xl`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">{children}</div>
      </aside>
    </div>
  );
}

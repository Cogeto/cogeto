import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryStatus } from '@cogeto/shared';
import { STATUS_META, statusLabel, TONE_CLASS } from './status';
import type { Tone } from './status';

/**
 * The canonical UI kit. One home for chips, badges, buttons, cards,
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
  useTranslation();
  const meta = STATUS_META[status];
  const label = statusLabel(status);
  return (
    <span className={`${BADGE} ${meta.className} ${className}`} title={label}>
      <span aria-hidden="true">{meta.icon}</span>
      {label}
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
  const { t } = useTranslation('common');
  return (
    <span
      className={`${BADGE} bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300`}
      title={t('badge.sensitive.title')}
    >
      <span aria-hidden="true">🔒</span>
      {t('badge.sensitive.label')}
    </span>
  );
}

export function SharedBadge({ owner }: { owner?: string | null }) {
  const { t } = useTranslation('common');
  return (
    <span
      className={`${BADGE} bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300`}
      title={t('badge.shared.title')}
    >
      <span aria-hidden="true">◇</span>
      {t('badge.shared.label')}
      {owner ? ` · ${owner}` : ''}
    </span>
  );
}

/** Private scope reads as a quiet tag, not a loud chip (it's the default). */
export function PrivateTag() {
  const { t } = useTranslation('common');
  return <span className="text-xs text-slate-400">{t('badge.private')}</span>;
}

/** Entity tag. A button when interactive, a plain span otherwise. */
export function EntityChip({
  name,
  onClick,
  title,
}: {
  name: string;
  onClick?: () => void;
  /** Overrides the default "Filter by {name}" tooltip (e.g. navigation). */
  title?: string;
}) {
  const { t } = useTranslation('common');
  const cls = 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600';
  return onClick ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${cls} hover:bg-slate-200`}
      title={title ?? t('entityChip.filterBy', { name })}
    >
      {name}
    </button>
  ) : (
    <span className={cls}>{name}</span>
  );
}

/** Verification verdict (spec §2) → tone. */
export function VerdictChip({ verdict }: { verdict: string }) {
  const { t } = useTranslation('common');
  const tone: Tone =
    verdict === 'supported' ? 'positive' : verdict === 'unsupported' ? 'danger' : 'warning';
  const icon = verdict === 'supported' ? '✓' : verdict === 'unsupported' ? '✕' : '≈';
  // The verdict VALUE is the API's; only its display name is translated, and an
  // unknown value falls through to itself rather than rendering a raw key.
  return (
    <Pill tone={tone} icon={icon}>
      {t(`verificationVerdict.${verdict}`, { defaultValue: verdict })}
    </Pill>
  );
}

/** Notification count for nav/tabs — with an accessible label. */
export function CountBadge({ count, label }: { count: number; label: string }) {
  const { t } = useTranslation('common');
  return (
    <span
      // amber-400 is a fixed badge color in both themes, so its ink must be
      // theme-independent too: brand-navy (not the remapping slate-900).
      className="rounded-full bg-amber-400 px-1.5 text-xs font-bold text-brand-navy"
      aria-label={t('countBadge.label', { count, noun: label })}
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
    <section className={`rounded-lg border border-slate-200 bg-surface p-4 shadow-sm ${className}`}>
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
        tone === 'positive'
          ? 'border-brand-teal/40 bg-brand-teal-surface/40 dark:border-brand-teal/30 dark:bg-brand-teal/10'
          : 'border-slate-300'
      }`}
    >
      {icon != null && (
        <div
          className={`mx-auto mb-2 text-2xl ${tone === 'positive' ? 'text-brand-teal-ink dark:text-brand-teal' : 'text-slate-400'}`}
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
  const { t } = useTranslation('common');
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
    >
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`${btnSecondary} ml-auto`}>
          {t('action.tryAgain')}
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

/** A few skeleton lines standing in for text/rows that are loading. */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = useTranslation('common');
  const text = label ?? t('state.loading');
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label={text}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`h-10 ${i === rows - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
      <span className="sr-only">{text}</span>
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
              ? 'bg-surface text-slate-800 shadow-sm'
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
  const { t } = useTranslation('common');
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
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`absolute right-0 top-0 flex h-full w-full ${width} animate-drawer-in flex-col bg-surface shadow-xl`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label={t('action.close')}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">{children}</div>
      </aside>
    </div>
  );
}

// ── ConfirmDialog (the product's own confirmation, not the browser's) ────────

/**
 * What a confirmation says, as STRUCTURE rather than one string with `\n\n`
 * in it (issue #528).
 *
 * Seven consequential actions used `window.confirm`, which meant the browser
 * drew them, titled with the origin, with OK/Cancel in the BROWSER's language
 * rather than the user's, and the four rich messages rendered as cramped plain
 * text. The most important sentence in the product had the worst typography in
 * the product, and none of it could be tested, because jsdom implements no
 * `window.confirm`.
 */
export interface ConfirmRequest {
  /** The question, as a question. Always present. */
  title: string;
  /** What will actually happen, plainly. */
  consequence?: string;
  /** A caution that deserves its own weight (user-approved memories going). */
  note?: string;
  /** The safer route, offered quietly rather than argued for. */
  alternative?: string;
  /** The verb on the confirm button. A specific verb beats "OK" every time. */
  confirmLabel?: string;
  /** Destructive actions get the red button AND open focused on Cancel. */
  destructive?: boolean;
}

/**
 * Existing confirmation copy was written as one blob for `window.confirm`,
 * ending with a blank line and a restated question ("…\n\nDelete?"). The
 * dialog asks that question in its title and answers it on its button, so the
 * tail is dropped HERE rather than by rewording the source strings, which are
 * genuinely translated into three languages: splitting on the blank line the
 * translations all preserve loses nothing and needs no retranslation.
 */
export function consequenceOf(legacy: string): string {
  return legacy.split(/\n\s*\n/)[0]!.trim();
}

export function ConfirmDialog({
  request,
  onResolve,
}: {
  request: ConfirmRequest;
  onResolve: (confirmed: boolean) => void;
}) {
  const { t } = useTranslation('common');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // A destructive dialog opens on CANCEL: Enter is a reflex, and the reflex
    // should not be the one that deletes. Native confirm() focuses OK.
    (request.destructive ? cancelRef : confirmRef).current?.focus();
    const close = () => onResolve(false);
    // The SAME stack the drawers use, so a confirm raised from inside a drawer
    // takes Escape first and the drawer stays open behind it.
    drawerStack.push(close);
    const onKey = (event: KeyboardEvent) => {
      if (drawerStack[drawerStack.length - 1] !== close) return;
      if (event.key === 'Escape') onResolve(false);
      if (event.key !== 'Tab') return;
      // Focus stays inside the dialog: it is a decision, and tabbing out to
      // the page behind it would leave the question unanswered and unseen.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const index = drawerStack.indexOf(close);
      if (index >= 0) drawerStack.splice(index, 1);
      previouslyFocused?.focus?.();
    };
  }, [onResolve, request.destructive]);

  return (
    <div className="fixed inset-0 z-30 grid place-items-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
        onClick={() => onResolve(false)}
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={request.consequence ? 'confirm-consequence' : undefined}
        className="relative w-full max-w-md rounded-lg border border-slate-200 bg-surface p-5 shadow-xl"
      >
        <h2 id="confirm-title" className="text-sm font-semibold text-slate-800">
          {request.title}
        </h2>
        {request.consequence && (
          <p id="confirm-consequence" className="mt-2 text-xs leading-relaxed text-slate-600">
            {request.consequence}
          </p>
        )}
        {request.note && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            {request.note}
          </p>
        )}
        {request.alternative && (
          <p className="mt-2 text-xs leading-relaxed text-slate-400">{request.alternative}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={btnSecondary}
            onClick={() => onResolve(false)}
          >
            {t('action.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={request.destructive ? btnDanger : btnPrimary}
            onClick={() => onResolve(true)}
          >
            {request.confirmLabel ?? t('action.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

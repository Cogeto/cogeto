import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isDemoSession, logout } from '../auth/oidc';

/** Initials for the avatar chip (up to two words), the Nav rule. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const two = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  return two || '·';
}

/**
 * The navbar identity chip (docs/features/spaces.md section 3): the avatar at
 * the right end of the top bar, beside the instance-settings gear, with the
 * session menu behind it. The sidebar keeps its identity block too — that is
 * where an operator's runbook checks the version and Sign out, and this menu
 * is the navbar's own door to the same session controls.
 */
export function UserMenu({ userName, orgName }: { userName?: string; orgName?: string }) {
  const { t } = useTranslation('navigation');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const demo = isDemoSession();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('userMenu.open')}
        onClick={() => setOpen((value) => !value)}
        className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand-teal to-brand-teal-ink text-xs font-bold text-brand-navy transition-shadow hover:shadow-glow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal"
      >
        {initials(userName ?? '')}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('userMenu.open')}
          className="absolute right-0 top-full z-40 mt-1.5 w-56 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-lg animate-fade-in"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="border-b border-slate-100 px-3 py-2.5 leading-tight dark:border-slate-700">
            <span className="block truncate text-sm font-semibold text-slate-800">{userName}</span>
            {orgName && <span className="block truncate text-xs text-slate-400">{orgName}</span>}
          </div>
          {demo ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold text-brand-teal-ink dark:text-brand-teal">
              <span aria-hidden="true">●</span> {t('liveSandbox')}
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => void logout()}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-teal dark:hover:bg-white/10"
            >
              {t('signOut')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

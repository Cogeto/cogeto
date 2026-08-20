import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SpaceDto } from '@cogeto/shared';
import { createSpace, fetchSpaces, putCurrentSpace, renameSpace } from '../api';
import type { Session } from '../auth/oidc';
import { commitSpaceChange, currentSpaceId } from '../space';
import { useApiErrorMessage } from '../i18n/api-error';
import { CogIcon } from './CogIcon';
import { btnPrimary, btnSecondary } from './ui';

/** Search only earns its place once scanning beats reading (the record says
 * "more than about 7"). */
const SEARCH_THRESHOLD = 7;

/**
 * The space switcher (docs/features/spaces.md section 3): the leftmost element
 * of the top navbar on every page, so the current space — the single most
 * important UI state in the product — is visible at all times. A combobox in
 * the workspace-switcher idiom: the current space shown prominently, a
 * dropdown listing spaces with the current one marked, a search field once
 * the list outgrows a glance, and a pinned create action at the bottom.
 *
 * Switching persists the choice server-side and then reloads the page at the
 * same path (query params dropped: they name objects of the previous space).
 * The reload is the honesty mechanism: navigation in this SPA is full page
 * loads already, and nothing stale from the previous space can survive one.
 * A failed switch leaves the user exactly where they were and says so.
 */
export function SpaceSwitcher({ session }: { session: Session }) {
  const { t } = useTranslation('spaces');
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage(t);
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: () => fetchSpaces(session) });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState<'switch' | 'create' | 'rename' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const spaces = useMemo(() => data?.spaces ?? [], [data]);
  const currentId = currentSpaceId();
  const current = spaces.find((s) => s.id === currentId) ?? null;
  const searchable = spaces.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return spaces;
    return spaces.filter((s) => s.name.toLowerCase().includes(needle));
  }, [spaces, query]);

  // Close on an outside click; Escape is handled on the popup itself.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Opening focuses the search (when present) or the current space's option,
  // so a keyboard user lands where their next keystroke matters.
  useEffect(() => {
    if (!open) return;
    if (searchable) searchRef.current?.focus();
    else focusOption(currentId ?? undefined);
    // Intentionally keyed on `open` alone: this is an on-open effect.
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
    setCreating(false);
    setNewName('');
    setRenamingId(null);
    setError(null);
  }

  function focusOption(id?: string) {
    const options = optionButtons();
    const target = id
      ? (options.find((el) => el.dataset.spaceId === id) ?? options[0])
      : options[0];
    target?.focus();
  }

  function optionButtons(): HTMLButtonElement[] {
    return Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
  }

  /** Roving focus over the option list: arrows move, Home/End jump. */
  function onListKeyDown(event: React.KeyboardEvent) {
    const options = optionButtons();
    if (options.length === 0) return;
    const index = options.findIndex((el) => el === document.activeElement);
    const move = (next: number) => {
      event.preventDefault();
      options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(options.length - 1);
  }

  async function switchTo(space: SpaceDto) {
    if (space.id === currentId) {
      close();
      return;
    }
    setBusy('switch');
    setError(null);
    try {
      await putCurrentSpace(session, space.id);
      // Same path, params dropped: ?c= / ?src= / ?open= name objects of the
      // space being left. commitSpaceChange covers the page and navigates;
      // the reload rebinds the space and recomputes everything, so no badge
      // or list can briefly show the previous space, and a stalled
      // navigation retries instead of leaving the old page interactive (F8).
      commitSpaceChange(window.location.pathname, t('switcher.switching', { name: space.name }));
    } catch (cause) {
      setBusy(null);
      setError(
        t('switcher.switchFailed', { name: current?.name ?? t('switcher.thisSpace') }) +
          ' ' +
          errorMessage(cause),
      );
    }
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy('create');
    setError(null);
    try {
      await createSpace(session, name);
      // The server has already switched the creator; land on the new space's
      // dashboard, whose first-run state points at Chat and Sources. Same
      // committed mechanics as a switch (F8): cover, navigate, retry.
      commitSpaceChange('/', t('switcher.switching', { name }));
    } catch (cause) {
      setBusy(null);
      setError(errorMessage(cause, 'switcher.createFailed'));
    }
  }

  async function submitRename(space: SpaceDto) {
    const name = renameValue.trim();
    if (!name || busy) return;
    if (name === space.name) {
      setRenamingId(null);
      return;
    }
    setBusy('rename');
    setError(null);
    try {
      await renameSpace(session, space.id, name);
      await queryClient.invalidateQueries({ queryKey: ['spaces'] });
      setRenamingId(null);
      setBusy(null);
    } catch (cause) {
      setBusy(null);
      setError(errorMessage(cause, 'switcher.renameFailed'));
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('switcher.currentSpace', { name: current?.name ?? '' })}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex max-w-[16rem] items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal dark:hover:bg-white/10"
      >
        <SpaceGlyph />
        <span className="truncate">{current?.name ?? ' '}</span>
        <svg
          viewBox="0 0 20 20"
          className="h-3.5 w-3.5 shrink-0 text-slate-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8.5 10 12.5 14 8.5" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-40 mt-1.5 w-72 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-lg animate-fade-in"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
              triggerRef.current?.focus();
            }
          }}
        >
          {searchable && (
            <div className="border-b border-slate-100 p-2 dark:border-slate-700">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusOption();
                  }
                }}
                placeholder={t('switcher.searchPlaceholder')}
                aria-label={t('switcher.searchLabel')}
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-brand-teal"
              />
            </div>
          )}

          <ul
            ref={listRef}
            role="listbox"
            aria-label={t('switcher.listLabel')}
            className="max-h-72 overflow-y-auto p-1.5"
            onKeyDown={onListKeyDown}
          >
            {visible.length === 0 && (
              <li className="px-2.5 py-2 text-sm text-slate-500" role="presentation">
                {t('switcher.noMatches', { query: query.trim() })}
              </li>
            )}
            {visible.map((space) =>
              renamingId === space.id ? (
                <li key={space.id} role="presentation" className="px-1 py-0.5">
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitRename(space);
                    }}
                  >
                    <input
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      aria-label={t('switcher.renameLabel', { name: space.name })}
                      maxLength={120}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-brand-teal"
                    />
                    <button type="submit" disabled={busy === 'rename'} className={btnPrimary}>
                      {t('common:action.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      className={btnSecondary}
                    >
                      {t('common:action.cancel')}
                    </button>
                  </form>
                </li>
              ) : (
                <li key={space.id} role="presentation" className="group flex items-center gap-1">
                  <button
                    type="button"
                    role="option"
                    aria-selected={space.id === currentId}
                    data-space-id={space.id}
                    disabled={busy === 'switch'}
                    onClick={() => void switchTo(space)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-teal dark:hover:bg-white/10"
                  >
                    <span
                      className={`grid h-4 w-4 shrink-0 place-items-center text-brand-teal-ink dark:text-brand-teal ${
                        space.id === currentId ? '' : 'invisible'
                      }`}
                      aria-hidden="true"
                    >
                      <svg
                        viewBox="0 0 20 20"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4.5 10.5 8.5 14.5 15.5 6" />
                      </svg>
                    </span>
                    <span className="truncate">{space.name}</span>
                    {space.id === currentId && (
                      <span className="sr-only">({t('switcher.currentMarker')})</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(space.id);
                      setRenameValue(space.name);
                      setError(null);
                    }}
                    aria-label={t('switcher.renameLabel', { name: space.name })}
                    className="mr-1 rounded p-1.5 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand-teal group-hover:opacity-100 dark:hover:bg-white/10"
                  >
                    <svg
                      viewBox="0 0 20 20"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12.8 3.6 16.4 7.2 7.2 16.4 3.2 16.8 3.6 12.8z" />
                    </svg>
                  </button>
                </li>
              ),
            )}
          </ul>

          <div className="border-t border-slate-100 p-1.5 dark:border-slate-700">
            <a
              href="/settings"
              className="group flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-teal dark:hover:bg-white/10"
            >
              <CogIcon className="h-[18px] w-[18px] text-slate-400 transition-transform duration-300 ease-out group-hover:rotate-45 group-focus-visible:rotate-45" />
              {t('switcher.spaceSettings')}
            </a>
            {creating ? (
              <form
                className="flex items-center gap-1.5 px-1 py-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreate();
                }}
              >
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder={t('switcher.namePlaceholder')}
                  aria-label={t('switcher.nameLabel')}
                  maxLength={120}
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-brand-teal"
                />
                <button
                  type="submit"
                  disabled={busy === 'create' || newName.trim() === ''}
                  className={btnPrimary}
                >
                  {busy === 'create' ? t('switcher.creating') : t('switcher.create')}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setError(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-semibold text-brand-teal-ink transition-colors hover:bg-brand-teal/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-teal dark:text-brand-teal"
              >
                <span aria-hidden="true" className="grid h-4 w-4 place-items-center">
                  <svg
                    viewBox="0 0 20 20"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M10 4.5v11M4.5 10h11" />
                  </svg>
                </span>
                {t('switcher.newSpace')}
              </button>
            )}
            {error && (
              <p role="alert" className="px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The space glyph: a sealed partition on the recurring node motif. */
function SpaceGlyph() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4 shrink-0 text-brand-teal-ink dark:text-brand-teal"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3" />
      <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <path d="M10 3.2v3.4M10 13.4v3.4M3.2 10h3.4M13.4 10h3.4" opacity="0.45" />
    </svg>
  );
}

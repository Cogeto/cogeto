import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProjectDto } from '@cogeto/shared';
import { createProject, deleteProject, setProjectArchived, updateProject } from '../api';
import type { Session } from '../auth/oidc';
import { useConfirm } from './confirm';
import { MARKER_CLASSES, deleteProjectConfirm } from './projects-model';

/**
 * The conversation rail's project SECTION HEADER (V2.5 item 8.3, interface
 * rework), and the `PROJECTS` heading that opens the section list.
 *
 * Membership is shown by GROUPING rather than by a filter dropdown, so the
 * header carries the project's identity (marker dot, name, count) and its
 * lifecycle actions. Those actions reveal inline on hover or focus, exactly
 * as the conversation row's own actions do, rather than in a floating menu:
 * the header owns the full 256px and holds nothing else, which is the space
 * the first shape of this feature did not have.
 */

/** A section's own new-conversation control, so a project you just made has
 * an obvious way in. */
export function ProjectSectionHeader({
  session,
  project,
  count,
  collapsed,
  onToggle,
}: {
  session: Session;
  /** Null renders the trailing "no project" heading, which has no actions. */
  project: ProjectDto | null;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('projects');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const rename = useMutation({
    mutationFn: (name: string) => updateProject(session, project!.id, { name }),
    onSuccess: async () => {
      setRenaming(false);
      await refresh();
    },
  });
  const lens = useMutation({
    mutationFn: () => updateProject(session, project!.id, { lensEnabled: !project!.lensEnabled }),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: () => setProjectArchived(session, project!.id, !project!.archived),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!(await confirm(deleteProjectConfirm(project!)))) return null;
      return deleteProject(session, project!.id);
    },
    onSuccess: async (result) => {
      if (!result) return;
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });

  if (renaming && project) {
    return (
      <form
        className="flex items-center gap-1.5 px-1.5 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draft.trim();
          if (name) rename.mutate(name);
        }}
      >
        <label className="sr-only" htmlFor={`rename-project-${project.id}`}>
          {t('field.name')}
        </label>
        <input
          id={`rename-project-${project.id}`}
          autoFocus
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setRenaming(false);
          }}
          className="w-full rounded border border-slate-300 bg-surface px-1.5 py-0.5 text-sm text-slate-800 outline-none focus:border-brand-teal"
        />
        <button
          type="submit"
          disabled={rename.isPending || !draft.trim()}
          className="text-xs font-semibold text-brand-teal-ink disabled:opacity-40 dark:text-brand-teal"
        >
          {t('common:action.save')}
        </button>
        <button
          type="button"
          onClick={() => setRenaming(false)}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          {t('common:action.cancel')}
        </button>
      </form>
    );
  }

  return (
    <div className="group/section px-1.5 pt-2.5 pb-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span aria-hidden="true" className="w-2 shrink-0 text-[0.6rem] text-slate-400">
            {collapsed ? '▸' : '▾'}
          </span>
          {project?.marker && (
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${MARKER_CLASSES[project.marker]}`}
            />
          )}
          <span
            className={`min-w-0 truncate font-mono text-[0.66rem] uppercase tracking-[0.1em] ${
              project?.archived ? 'text-slate-300' : 'text-slate-500'
            }`}
          >
            {project ? project.name : t('rail.noProject')}
          </span>
          <span className="shrink-0 font-mono text-[0.6rem] text-slate-400">{count}</span>
        </button>
      </div>
      {project && (
        <div className="mt-0.5 ml-4 hidden flex-wrap items-center gap-2 group-focus-within/section:flex group-hover/section:flex">
          <button
            type="button"
            onClick={() => {
              setDraft(project.name);
              setRenaming(true);
            }}
            className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink dark:hover:text-brand-teal"
          >
            {t('action.rename')}
          </button>
          <button
            type="button"
            onClick={() => lens.mutate()}
            disabled={lens.isPending}
            aria-pressed={project.lensEnabled}
            title={project.lensEnabled ? t('rail.lensOn') : t('rail.lensOff')}
            className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
          >
            {project.lensEnabled ? t('rail.turnLensOff') : t('rail.turnLensOn')}
          </button>
          <button
            type="button"
            onClick={() => archive.mutate()}
            disabled={archive.isPending}
            className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
          >
            {project.archived ? t('action.unarchive') : t('action.archive')}
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-slate-400 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300"
          >
            {t('action.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The list's create affordance: a full-width row in the same rhythm as the
 * conversations above it, with WORDS (V2.5 item 8.3 follow-up).
 *
 * Both create controls used to be bare `+` glyphs, one of them at
 * `text-slate-300` and revealed on hover, which made it invisible in practice
 * and unexplained when found. A row is a big target, it says what it does, and
 * it never depends on the pointer being in the right place.
 */
export function GhostRow({
  label,
  ariaLabel,
  onClick,
}: {
  label: string;
  /** The specific name, when the visible label has to stay short enough for
   * a 256px column ("New conversation" reading as "…in this project"). */
  ariaLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-400 transition-colors hover:bg-surface hover:text-brand-teal-ink dark:hover:text-brand-teal"
    >
      <span aria-hidden="true" className="font-mono text-[0.8rem] leading-none">
        +
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * The `PROJECTS` heading that opens the section list, carrying the create
 * button (V2.5 item 8.3 follow-up).
 *
 * It was a one-line control BELOW the sections, which put it at the bottom of
 * a scrolling list: the one place nobody looks, and unreachable without
 * scrolling past every conversation. On the heading the `+` is unambiguous,
 * because it sits on the word it creates, and it never scrolls out of reach.
 */
export function ProjectsHeading({ session }: { session: Session }) {
  const { t } = useTranslation('projects');
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');

  const create = useMutation({
    mutationFn: (name: string) => createProject(session, { name }),
    onSuccess: async () => {
      setCreating(false);
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  if (!creating) {
    return (
      <div className="pt-3">
        <p className="px-1.5 font-mono text-[0.66rem] uppercase tracking-[0.1em] text-slate-400">
          {t('rail.heading')}
        </p>
        {/* A labelled, full-width row rather than a bare `+`: the glyph alone
            was both an unreadable target and an unexplained one. */}
        <GhostRow label={t('rail.newProject')} onClick={() => setCreating(true)} />
      </div>
    );
  }
  return (
    <form
      className="flex items-center gap-1.5 px-1.5 pt-3 pb-0.5"
      onSubmit={(event) => {
        event.preventDefault();
        const name = draft.trim();
        if (name) create.mutate(name);
      }}
    >
      <label className="sr-only" htmlFor="new-project-name">
        {t('field.name')}
      </label>
      <input
        id="new-project-name"
        autoFocus
        value={draft}
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setCreating(false);
        }}
        placeholder={t('field.namePlaceholder')}
        className="w-full rounded border border-slate-300 bg-surface px-1.5 py-0.5 text-sm text-slate-800 outline-none focus:border-brand-teal"
      />
      <button
        type="submit"
        disabled={create.isPending || !draft.trim()}
        className="text-xs font-semibold text-brand-teal-ink disabled:opacity-40 dark:text-brand-teal"
      >
        {t('common:action.save')}
      </button>
      <button
        type="button"
        onClick={() => setCreating(false)}
        className="text-xs text-slate-400 hover:text-slate-600"
      >
        {t('common:action.cancel')}
      </button>
    </form>
  );
}

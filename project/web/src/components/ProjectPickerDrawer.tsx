import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProjectDto } from '@cogeto/shared';
import { assignToProject, createProject, fetchProjects } from '../api';
import type { Session } from '../auth/oidc';
import { Drawer } from './ui';
import { MARKER_CLASSES, splitProjects } from './projects-model';
import { useApiErrorMessage } from '../i18n/api-error';

/**
 * Moving a conversation into a project (V2.5 item 8.3, interface rework).
 *
 * The first shape of this put a `<select>` in the conversation row's hover
 * actions, inside a 256px rail that already held three controls. It
 * overflowed, and worse, it asked you to act on a conversation you were not
 * looking at. This asks you to act on the one you ARE reading, from a chip
 * above the thread, through the drawer primitive the rest of the app already
 * uses for "inspect and act on one thing".
 *
 * A radio group, not a dropdown: the whole point is seeing every project and
 * the "no project" option at once, with the current one already marked.
 */
export function ProjectPickerDrawer({
  session,
  conversationId,
  currentProjectId,
  onClose,
}: {
  session: Session;
  conversationId: string;
  currentProjectId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('projects');
  const apiError = useApiErrorMessage(t);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects(session),
  });

  const settle = async () => {
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const move = useMutation({
    mutationFn: (projectId: string | null) =>
      assignToProject(session, { kind: 'conversation', refId: conversationId }, projectId),
    onSuccess: async () => {
      setError(null);
      await settle();
      onClose();
    },
    onError: (err: Error) => setError(apiError(err)),
  });

  // Creating from here lands the conversation in the new project in one go:
  // the reason you are making a project right now is this conversation.
  const create = useMutation({
    mutationFn: async (name: string) => {
      const project = await createProject(session, { name });
      await assignToProject(session, { kind: 'conversation', refId: conversationId }, project.id);
      return project;
    },
    onSuccess: async () => {
      setError(null);
      await settle();
      onClose();
    },
    onError: (err: Error) => setError(apiError(err)),
  });

  const { active, archived } = splitProjects(projects ?? []);
  const busy = move.isPending || create.isPending;

  const option = (project: ProjectDto | null) => {
    const id = project?.id ?? null;
    const selected = currentProjectId === id;
    return (
      <li key={id ?? 'none'}>
        <label
          className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 transition-colors ${
            selected
              ? 'border-brand-teal/40 bg-brand-teal/10'
              : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          <input
            type="radio"
            name="project-picker"
            checked={selected}
            disabled={busy}
            onChange={() => move.mutate(id)}
            className="accent-brand-teal"
          />
          {project?.marker && (
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${MARKER_CLASSES[project.marker]}`}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
            {project ? project.name : t('assign.none')}
          </span>
          {project && !project.lensEnabled && (
            <span className="shrink-0 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400">
              {t('picker.lensOffTag')}
            </span>
          )}
          {project?.archived && (
            <span className="shrink-0 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400">
              {t('picker.archivedTag')}
            </span>
          )}
        </label>
      </li>
    );
  };

  return (
    <Drawer title={t('picker.title')} onClose={onClose} width="max-w-md">
      <p className="text-xs leading-relaxed text-slate-500">{t('picker.explainer')}</p>
      <ul className="space-y-1.5">
        {option(null)}
        {active.map((project) => option(project))}
        {archived.map((project) => option(project))}
      </ul>
      {creating ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.trim();
            if (name) create.mutate(name);
          }}
        >
          <label className="sr-only" htmlFor="picker-project-name">
            {t('field.name')}
          </label>
          <input
            id="picker-project-name"
            autoFocus
            value={draft}
            maxLength={80}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setCreating(false);
            }}
            placeholder={t('field.namePlaceholder')}
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-surface px-2 py-1.5 text-sm text-slate-800 outline-none focus:border-brand-teal"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="shrink-0 text-xs font-semibold text-brand-teal-ink disabled:opacity-40 dark:text-brand-teal"
          >
            {t('common:action.save')}
          </button>
          <button
            type="button"
            onClick={() => setCreating(false)}
            className="shrink-0 text-xs text-slate-400 hover:text-slate-600"
          >
            {t('common:action.cancel')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-left text-xs text-slate-500 transition-colors hover:border-brand-teal hover:text-brand-teal-ink dark:hover:text-brand-teal"
        >
          {t('picker.newProject')}
        </button>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}
    </Drawer>
  );
}

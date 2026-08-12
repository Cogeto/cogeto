import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProjectDto } from '@cogeto/shared';
import {
  createProject,
  deleteProject,
  fetchProjects,
  setProjectArchived,
  updateProject,
} from '../api';
import type { Session } from '../auth/oidc';
import { MARKER_CLASSES, deleteProjectConfirm, splitProjects } from './projects-model';

/**
 * Project selection in the conversation sidebar (V2.5 item 8.3 issue D1).
 *
 * The design constraint that shapes every line here: **unassigned use must
 * stay frictionless.** A user who never creates a project sees one small
 * select whose default is "all conversations", and nothing else about the
 * page changes. Creating a project is one action; the lifecycle actions
 * appear only once a project is selected.
 *
 * Archiving is offered first because it is the safe action. Deleting says, in
 * the dialog, that the contents survive.
 */
export function ProjectRail({
  session,
  selectedId,
  onSelect,
}: {
  session: Session;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation('projects');
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects(session),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: (name: string) => createProject(session, { name }),
    onSuccess: (project) => {
      setCreating(false);
      setDraft('');
      void refresh();
      onSelect(project.id);
    },
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      setProjectArchived(session, id, archived),
    onSuccess: () => void refresh(),
  });
  const lens = useMutation({
    mutationFn: ({ id, lensEnabled }: { id: string; lensEnabled: boolean }) =>
      updateProject(session, id, { lensEnabled }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: async (project: ProjectDto) => {
      if (!window.confirm(deleteProjectConfirm(project))) return null;
      return deleteProject(session, project.id);
    },
    onSuccess: (result) => {
      if (!result) return;
      void refresh();
      // Everything the project grouped is now unassigned and still there.
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['source-catalog'] });
      onSelect(null);
    },
  });

  const { active, archived } = splitProjects(projects ?? []);
  const selected = (projects ?? []).find((p) => p.id === selectedId) ?? null;

  return (
    <div className="border-b border-slate-200 px-3 pt-3 pb-2.5">
      <label
        className="mb-1 block font-mono text-[0.62rem] uppercase tracking-[0.12em] text-slate-400"
        htmlFor="project-select"
      >
        {t('rail.label')}
      </label>
      {creating ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.trim();
            if (name) create.mutate(name);
          }}
        >
          <label className="sr-only" htmlFor="project-name">
            {t('field.name')}
          </label>
          <input
            id="project-name"
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
      ) : (
        <div className="flex items-center gap-1.5">
          <select
            id="project-select"
            value={selectedId ?? ''}
            onChange={(event) => onSelect(event.target.value || null)}
            className="min-w-0 flex-1 rounded border border-slate-300 bg-surface px-1.5 py-1 text-sm text-slate-700 outline-none focus:border-brand-teal"
          >
            <option value="">{t('rail.all')}</option>
            {active.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            {archived.length > 0 && (
              <optgroup label={t('rail.archivedGroup')}>
                {archived.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            onClick={() => setCreating(true)}
            title={t('rail.new')}
            aria-label={t('rail.new')}
            className="shrink-0 rounded border border-slate-300 px-1.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-500 transition-colors hover:border-brand-teal hover:text-brand-teal-ink dark:hover:text-brand-teal"
          >
            {t('rail.newShort')}
          </button>
        </div>
      )}
      {selected && (
        <div className="mt-1.5">
          <p className="flex items-center gap-1.5 text-[0.68rem] leading-relaxed text-slate-400">
            {selected.marker && (
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${MARKER_CLASSES[selected.marker]}`}
              />
            )}
            <span>{selected.lensEnabled ? t('rail.lensOn') : t('rail.lensOff')}</span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => lens.mutate({ id: selected.id, lensEnabled: !selected.lensEnabled })}
              disabled={lens.isPending}
              aria-pressed={selected.lensEnabled}
              className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
            >
              {selected.lensEnabled ? t('rail.turnLensOff') : t('rail.turnLensOn')}
            </button>
            <button
              type="button"
              onClick={() => archive.mutate({ id: selected.id, archived: !selected.archived })}
              disabled={archive.isPending}
              className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
            >
              {selected.archived ? t('action.unarchive') : t('action.archive')}
            </button>
            <button
              type="button"
              onClick={() => remove.mutate(selected)}
              disabled={remove.isPending}
              className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300"
            >
              {t('action.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

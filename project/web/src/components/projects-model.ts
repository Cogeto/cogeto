import type { ProjectDto, ProjectMarker } from '@cogeto/shared';
import { i18next } from '../i18n';

/**
 * Pure presentation logic for projects (V2.5 item 8.3), React-free so the
 * lifecycle rules are unit-testable: the marker to design-token map, the
 * active/archived split, and the two confirmations whose WORDING is the whole
 * point of the feature's lifecycle rule.
 */

/**
 * Marker key to design-system token classes. Token names, never hex: the
 * palette belongs to the theme, so a project keeps its identity in both
 * themes and a palette change reaches every project at once.
 */
export const MARKER_CLASSES: Record<ProjectMarker, string> = {
  slate: 'bg-slate-400',
  indigo: 'bg-indigo-400',
  teal: 'bg-brand-teal',
  sage: 'bg-emerald-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  plum: 'bg-purple-400',
};

/** Active first, archived collapsed: the conversation sidebar's own shape. */
export function splitProjects(projects: ProjectDto[]): {
  active: ProjectDto[];
  archived: ProjectDto[];
} {
  return {
    active: projects.filter((p) => !p.archived),
    archived: projects.filter((p) => p.archived),
  };
}

/** How many things a project groups, across every kind. */
export function assignmentTotal(project: ProjectDto): number {
  return Object.values(project.counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

/**
 * THE DELETE CONFIRMATION, and the reason this file exists.
 *
 * A user deleting a client folder in most software expects the contents to go
 * with it. Here they do not: the project record goes, and its conversations,
 * sources, research runs and reports all remain, unassigned. The dialog says
 * exactly that, in those words, because the difference is the whole point.
 */
export function deleteProjectConfirm(project: ProjectDto): string {
  const t = i18next.getFixedT(null, 'projects');
  const lines = [
    t('delete.question', { name: project.name }),
    '',
    t('delete.consequence', { count: assignmentTotal(project) }),
    t('delete.keeps'),
    '',
    t('delete.alternative'),
  ];
  return lines.join('\n');
}

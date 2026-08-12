import type { ConversationDto, ProjectDto, ProjectMarker } from '@cogeto/shared';
import { i18next } from '../i18n';

/**
 * Pure presentation logic for projects (V2.5 item 8.3), React-free so the
 * lifecycle rules are unit-testable: the marker to design-token map, the
 * active/archived split, the rail's GROUPING rule, and the confirmation whose
 * WORDING is the whole point of the feature's lifecycle rule.
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

/**
 * The same markers as LEFT-BORDER classes, for the rule that runs down a
 * project's conversations in the rail. Written out rather than derived from
 * MARKER_CLASSES by string surgery, because Tailwind scans source for whole
 * class names and would generate nothing for a name assembled at runtime.
 */
export const MARKER_RULE_CLASSES: Record<ProjectMarker, string> = {
  slate: 'border-slate-400',
  indigo: 'border-indigo-400',
  teal: 'border-brand-teal',
  sage: 'border-emerald-400',
  amber: 'border-amber-400',
  rose: 'border-rose-400',
  plum: 'border-purple-400',
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

/** One section of the grouped conversation rail. `project` null is the trailing
 * "no project" section, which is where an instance with no projects keeps
 * every conversation it has. */
export interface RailSection {
  project: ProjectDto | null;
  conversations: ConversationDto[];
}

/**
 * THE RAIL'S GROUPING RULE (the V2.5 item 8.3 interface rework).
 *
 * Membership has to be visible while SCANNING, not something you go looking
 * for behind a filter: the first shape of this feature hid it behind a
 * dropdown and put the move control in a hover row that overflowed a 256px
 * column, and both mistakes came from treating a project as a filter rather
 * than as a place.
 *
 * - **No project exists → no sections at all.** A user who ignores projects
 *   sees exactly the flat list they saw before this feature, which is the
 *   inert-by-default promise, kept in the interface as well as in retrieval.
 * - Every ACTIVE project gets a section, even an empty one, because an empty
 *   section is how you start a conversation in a project you just made.
 * - An ARCHIVED project keeps a section only while it still holds
 *   conversations: nothing a user assigned may silently vanish from the rail.
 * - "No project" comes last and is omitted when empty.
 *
 * Archived CONVERSATIONS are not grouped: they stay in the rail's existing
 * collapsed section, because nesting one collapse inside another buys nothing.
 */
export function railSections(
  conversations: ConversationDto[],
  projects: ProjectDto[],
): { sections: RailSection[]; grouped: boolean } {
  const active = conversations.filter((conversation) => !conversation.archived);
  const { active: activeProjects, archived: archivedProjects } = splitProjects(projects);
  if (projects.length === 0) {
    return { sections: [{ project: null, conversations: active }], grouped: false };
  }
  const held = (project: ProjectDto) =>
    active.filter((conversation) => conversation.projectId === project.id);
  const sections: RailSection[] = activeProjects.map((project) => ({
    project,
    conversations: held(project),
  }));
  for (const project of archivedProjects) {
    const kept = held(project);
    if (kept.length > 0) sections.push({ project, conversations: kept });
  }
  const known = new Set(projects.map((project) => project.id));
  const loose = active.filter(
    (conversation) => !conversation.projectId || !known.has(conversation.projectId),
  );
  if (loose.length > 0) sections.push({ project: null, conversations: loose });
  return { sections, grouped: true };
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

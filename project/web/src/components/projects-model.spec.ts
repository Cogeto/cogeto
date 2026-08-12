import { describe, expect, it } from 'vitest';
import type { ProjectDto } from '@cogeto/shared';
import { PROJECT_MARKERS } from '@cogeto/shared';
import type { ConversationDto } from '@cogeto/shared';
import {
  assignmentTotal,
  deleteProjectConfirm,
  MARKER_CLASSES,
  railSections,
  splitProjects,
} from './projects-model';

/**
 * Projects as workspaces, presentation rules (V2.5 item 8.3 issue D).
 *
 *   delete_confirm_states_contents_survive — the one that matters. A user
 *     deleting a client folder in most software expects the contents to go
 *     with it; here they do not, and the dialog has to say so. This test
 *     fails if that sentence ever leaves the confirmation.
 *   marker_tokens_complete — every marker maps to a design-system token, so
 *     adding one without deciding its colour is a failure, not a blank chip.
 *   project_split — active first, archived collapsed.
 */

const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: 'p-1',
  name: 'Client A',
  description: null,
  marker: null,
  archived: false,
  lensEnabled: true,
  extraction: { enabled: null, factBudget: null, retentionDays: null },
  counts: { source: 3, conversation: 2 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const conversation = (id: string, projectId: string | null, archived = false): ConversationDto => ({
  id,
  title: id,
  titleSetByUser: false,
  archived,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastMessagePreview: null,
  projectId,
});

describe('projects model', () => {
  it('rail_flat_without_projects: a user who ignores projects sees the list they always saw', () => {
    const { sections, grouped } = railSections(
      [conversation('a', null), conversation('b', null)],
      [],
    );
    expect(grouped).toBe(false);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.project).toBe(null);
    expect(sections[0]!.conversations.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('rail_groups_once_a_project_exists, empty sections included', () => {
    const clientA = project({ id: 'p-a', name: 'Client A' });
    const empty = project({ id: 'p-empty', name: 'Empty' });
    const { sections, grouped } = railSections(
      [conversation('a1', 'p-a'), conversation('loose', null)],
      [clientA, empty],
    );
    expect(grouped).toBe(true);
    expect(sections.map((s) => s.project?.name ?? 'none')).toEqual(['Client A', 'Empty', 'none']);
    // An empty project still gets its section: that is how you start the
    // first conversation in a project you just made.
    expect(sections[1]!.conversations).toEqual([]);
    expect(sections[2]!.conversations.map((c) => c.id)).toEqual(['loose']);
  });

  it('rail_no_project_section_is_omitted_when_empty', () => {
    const { sections } = railSections(
      [conversation('a1', 'p-a')],
      [project({ id: 'p-a', name: 'Client A' })],
    );
    expect(sections.map((s) => s.project?.id ?? 'none')).toEqual(['p-a']);
  });

  it('rail_archived_project_keeps_its_section_while_it_holds_conversations', () => {
    const live = project({ id: 'p-a', name: 'Client A' });
    const old = project({ id: 'p-old', name: 'Old client', archived: true });
    const withRows = railSections([conversation('x', 'p-old')], [live, old]);
    // Nothing a user assigned may silently vanish from the rail.
    expect(withRows.sections.map((s) => s.project?.id ?? 'none')).toEqual(['p-a', 'p-old']);
    // Emptied, the archived project stops taking up room.
    const without = railSections([conversation('y', 'p-a')], [live, old]);
    expect(without.sections.map((s) => s.project?.id ?? 'none')).toEqual(['p-a']);
  });

  it('rail_archived_conversations_are_not_grouped: they stay in the flat collapsed section', () => {
    const { sections } = railSections(
      [conversation('live', 'p-a'), conversation('gone', 'p-a', true)],
      [project({ id: 'p-a', name: 'Client A' })],
    );
    expect(sections[0]!.conversations.map((c) => c.id)).toEqual(['live']);
  });

  it('rail_unknown_project_falls_back_to_no_project: a stale id never hides a conversation', () => {
    const { sections } = railSections(
      [conversation('orphan', 'p-deleted')],
      [project({ id: 'p-a', name: 'Client A' })],
    );
    const loose = sections.find((s) => s.project === null);
    expect(loose?.conversations.map((c) => c.id)).toEqual(['orphan']);
  });

  it('delete_confirm_states_contents_survive: the dialog promises what actually happens', () => {
    const request = deleteProjectConfirm(project());
    // The question names the project it is about.
    expect(request.title).toContain('Client A');
    // The whole lifecycle rule, in the consequence: the contents stay.
    expect(request.consequence).toMatch(/stay exactly where they are/i);
    expect(request.consequence).toMatch(/Nothing is erased/i);
    // The count comes from the REAL assignment totals, never a guess.
    expect(request.consequence).toContain('5');
    // The two other doors are named as the ALTERNATIVE, its own field now
    // rather than a paragraph glued on with newlines (issue #528): source
    // deletion for real erasure, archiving as the safe route.
    expect(request.alternative).toMatch(/deletion saga|receipt/i);
    expect(request.alternative).toMatch(/archiv/i);
    // Deleting a project is destructive, so it gets the red button and opens
    // focused on Cancel.
    expect(request.destructive).toBe(true);
    expect(request.confirmLabel).toBeTruthy();
  });

  it('marker_tokens_complete: every marker has a design-system class', () => {
    for (const marker of PROJECT_MARKERS) {
      expect(MARKER_CLASSES[marker]).toBeTruthy();
      // Token classes only: a stored hex would outlive the palette.
      expect(MARKER_CLASSES[marker]).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it('assignment_total: counts every kind the project groups', () => {
    expect(assignmentTotal(project())).toBe(5);
    expect(assignmentTotal(project({ counts: {} }))).toBe(0);
  });

  it('project_split: active first, archived apart', () => {
    const { active, archived } = splitProjects([
      project({ id: 'a' }),
      project({ id: 'b', name: 'Old', archived: true }),
    ]);
    expect(active.map((p) => p.id)).toEqual(['a']);
    expect(archived.map((p) => p.id)).toEqual(['b']);
  });
});

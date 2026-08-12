import { describe, expect, it } from 'vitest';
import type { ProjectDto } from '@cogeto/shared';
import { PROJECT_MARKERS } from '@cogeto/shared';
import {
  assignmentTotal,
  deleteProjectConfirm,
  MARKER_CLASSES,
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

describe('projects model', () => {
  it('delete_confirm_states_contents_survive: the dialog promises what actually happens', () => {
    const text = deleteProjectConfirm(project());
    expect(text).toContain('Client A');
    // The whole lifecycle rule, in the dialog: the contents stay.
    expect(text).toMatch(/stay exactly where they are/i);
    expect(text).toMatch(/Nothing is erased/i);
    // And the two other doors are named: source deletion for real erasure,
    // archiving as the safe alternative.
    expect(text).toMatch(/deletion saga|receipt/i);
    expect(text).toMatch(/archiv/i);
    // The count comes from the REAL assignment totals, never a guess.
    expect(text).toContain('5');
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

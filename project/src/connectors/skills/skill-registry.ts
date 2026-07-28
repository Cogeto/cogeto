import type { SkillStepKind } from '@cogeto/shared';

/**
 * The skill registry (decision 0059 ruling 1): skills are code artifacts,
 * versioned like prompts — named, numbered, immutable once released. A skill's
 * declared plan is the ordered set of typed steps its runs are created from;
 * the run's step log is always readable against this declaration.
 *
 * v1 ships exactly one skill. Adding a second means adding a definition here,
 * its prompt families, and its step handlers in the engine — never a change to
 * the runtime's governance (the gate, the creates-nothing rule, budgets).
 */

export interface SkillStepDef {
  key: string;
  kind: SkillStepKind;
  /** Human-phrased step titles — the run view's language (en UI; the brief
   * itself speaks preferred_language per decision 0052). */
  title: string;
}

export interface SkillDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  steps: SkillStepDef[];
}

/** skills/research_brief/v0002 — research a company or person before a meeting. */
export const RESEARCH_BRIEF_SKILL: SkillDefinition = {
  id: 'research_brief',
  // v0002 (decision 0060): the `propose_actions` step went with the task
  // subsystem — a skill proposed adoption of an observed obligation as a task,
  // and there is nothing to adopt into. Skills are versioned like prompts, so
  // the plan change bumps the version; runs recorded under v0001 keep their
  // step log and stay readable against the v0001 declaration.
  version: 'v0002',
  name: 'Research a company or person before a meeting',
  description:
    'Gathers what you already know, proposes minimised searches for your approval, ' +
    'reads the approved pages, and writes a sourced brief.',
  steps: [
    { key: 'gather_memory', kind: 'gather_from_memory', title: 'Checking what you already know' },
    {
      key: 'plan_searches',
      kind: 'propose_searches',
      title: 'Proposing searches for your approval',
    },
    { key: 'gated_search', kind: 'gated_search', title: 'Searching with your approved queries' },
    { key: 'read_pages', kind: 'fetch_and_extract', title: 'Reading the selected pages' },
    { key: 'verify', kind: 'verify', title: 'Verifying and reconciling what was found' },
    { key: 'write_brief', kind: 'synthesise', title: 'Writing the brief' },
  ],
};

const SKILLS: ReadonlyMap<string, SkillDefinition> = new Map([
  [RESEARCH_BRIEF_SKILL.id, RESEARCH_BRIEF_SKILL],
]);

export function getSkill(id: string): SkillDefinition | null {
  return SKILLS.get(id) ?? null;
}

export function listSkills(): SkillDefinition[] {
  return [...SKILLS.values()];
}

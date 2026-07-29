import type { ResearchCitationDto } from './research';

/**
 * Named skills: a skill is a named,
 * versioned, code-defined multi-step workflow. One skill_run records one
 * invocation; its step log is the inspectability claim — every step's status,
 * summaries, and links to everything it produced, one click away.
 */

export const SKILL_RUN_STATUSES = [
  'planning',
  'awaiting_approval',
  'running',
  'awaiting_input',
  'completed',
  'failed',
  'cancelled',
] as const;

export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number];

export const SKILL_STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
] as const;

export type SkillStepStatus = (typeof SKILL_STEP_STATUSES)[number];

/** The declared step kinds a skill plan is composed of. */
export const SKILL_STEP_KINDS = [
  'gather_from_memory',
  'propose_searches',
  'gated_search',
  'fetch_and_extract',
  'verify',
  'synthesise',
] as const;

export type SkillStepKind = (typeof SKILL_STEP_KINDS)[number];

/** One step of a run's log, readable against the plan that produced it. */
export interface SkillRunStepDto {
  id: string;
  position: number;
  stepKey: string;
  kind: SkillStepKind;
  status: SkillStepStatus;
  /** Human-phrased step title ("Checking what you already know"). */
  title: string;
  inputsSummary: string | null;
  outputsSummary: string | null;
  /** Links to everything the step produced (research run ids, page ids,
   * memory ids, counts) — the artifacts one click away. */
  links: SkillStepLinks;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Artifact references a step recorded; every field optional per step kind. */
export interface SkillStepLinks {
  memoryIds?: string[];
  /** Memories deriving the subject's open loops (the gather step records them
   * separately so the brief can show what the meeting could close). */
  loopMemoryIds?: string[];
  researchRunIds?: string[];
  pageIds?: string[];
  /** Research runs whose discovery already ran (the advance job's resume guard). */
  searched?: string[];
  counts?: Record<string, number>;
  notes?: string[];
}

/** One query of the skill's plan as shown at the gate — an ordinary research
 * run: approve/edit/remove each before anything leaves. */
export interface SkillPlanQueryDto {
  researchRunId: string;
  status: 'proposed' | 'approved' | 'cancelled' | 'concluded';
  proposedQuery: string;
  minimisedQuery: string;
  minimiseReason: string;
  sentQuery: string | null;
}

export interface SkillRunDto {
  id: string;
  skillId: string;
  skillVersion: string;
  /** Human-readable skill name ("Research a company or person before a meeting"). */
  skillName: string;
  subject: string;
  status: SkillRunStatus;
  failureReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

/** The full run view: the step log, the query plan and the brief. */
export interface SkillRunDetailDto extends SkillRunDto {
  steps: SkillRunStepDto[];
  plan: SkillPlanQueryDto[];
  /** The durable brief ([M#]/[W#] markers); null until synthesised. */
  brief: string | null;
  briefCitations: ResearchCitationDto[];
}

export interface ProposeSkillRunRequest {
  skillId: string;
  subject: string;
  /** The invoking chat conversation, when proposed from chat. */
  conversationId?: string;
}

/** Ambiguous subjects ask before planning: nothing is created. */
export type ProposeSkillRunResponse =
  { status: 'created'; run: SkillRunDetailDto } | { status: 'ambiguous'; candidates: string[] };

/** The plan-gate decision, one interaction: kept queries (possibly edited)
 * approve; everything omitted is cancelled and never leaves. */
export interface ApproveSkillPlanRequest {
  queries: { researchRunId: string; query: string }[];
}

/** A skill run proposed from chat: the done event's handle —
 * the run view owns the gate and the live progress. Ephemeral, like the
 * research proposal ref. */
export interface ChatSkillRunRef {
  runId: string;
}

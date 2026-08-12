/**
 * Projects as workspaces (V2.5 item 8.3): the DTOs both tiers share.
 *
 * A project is a folder for the WORK, never a compartment for the knowledge.
 * Nothing in this file touches memory scoping: there is no project on a
 * memory, no project in a gate, and no project in the vector payload. The
 * decision record is docs/features/projects.md and it is binding.
 */

/** What a project can group. Five kinds, one assignment table. */
export const PROJECT_ASSIGNMENT_KINDS = [
  'source',
  'conversation',
  'research_run',
  'connector_sub_scope',
  'findings_report',
] as const;
export type ProjectAssignmentKind = (typeof PROJECT_ASSIGNMENT_KINDS)[number];

/**
 * The `ref_type` a conversation assignment carries. It is the conversation's
 * SOURCE type, not the word "conversation", so the deletion cascade releases a
 * conversation's assignment through exactly the same arm as a document's:
 * `releaseRef(sourceType, sourceId)`, with no per-kind mapping to keep in step.
 */
export const CONVERSATION_REF_TYPE = 'chat_conversation';

/**
 * The `ref_type` for one assignment kind. `source` is the only kind whose ref
 * type varies (it is the source type); the other four are constant, so a
 * caller names the kind and the ref id and nothing else.
 */
export function projectRefTypeFor(kind: ProjectAssignmentKind, sourceType?: string): string {
  if (kind === 'source') {
    if (!sourceType) throw new Error('a source assignment needs its source type');
    return sourceType;
  }
  return kind === 'conversation' ? CONVERSATION_REF_TYPE : kind;
}

/**
 * The colour markers a project can carry. Design-system token KEYS, never hex
 * values: the SPA maps each to a theme token, so a project keeps its identity
 * in both themes and a palette change reaches every project at once.
 */
export const PROJECT_MARKERS = [
  'slate',
  'indigo',
  'teal',
  'sage',
  'amber',
  'rose',
  'plum',
] as const;
export type ProjectMarker = (typeof PROJECT_MARKERS)[number];

/** The per-project extraction policy: three optional numbers, nothing more. */
export interface ProjectExtractionPolicyDto {
  /** null = the project has no opinion; false = store but do not extract. */
  enabled: boolean | null;
  /** Folds into the tightest-wins fact-budget arithmetic; null = no bound. */
  factBudget: number | null;
  /** Blanket validity for facts that resolved none of their own; null = none. */
  retentionDays: number | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  marker: ProjectMarker | null;
  archived: boolean;
  /** Conversations in this project narrow retrieval to its sources. */
  lensEnabled: boolean;
  extraction: ProjectExtractionPolicyDto;
  /** How many things of each kind the project groups. Zeroes are omitted. */
  counts: Partial<Record<ProjectAssignmentKind, number>>;
  createdAt: string;
  updatedAt: string;
}

/** One assignment, as the project detail lists it. */
export interface ProjectAssignmentDto {
  kind: ProjectAssignmentKind;
  /** The source type for `source` rows; the kind itself for the other four. */
  refType: string;
  refId: string;
  createdAt: string;
}

/** POST /api/projects and PUT /api/projects/:id take this shape. */
export interface ProjectWriteDto {
  name: string;
  description?: string | null;
  marker?: ProjectMarker | null;
  lensEnabled?: boolean;
  extraction?: Partial<ProjectExtractionPolicyDto>;
}

/**
 * What the retrieval lens did on one answered turn (stored on the message, so
 * re-opening a conversation renders the same labels it showed live).
 * Identifiers and booleans: never a project name, never content.
 */
export interface ChatLensDto {
  projectId: string;
  /** The lens narrowed this turn's retrieval. */
  applied: boolean;
  /** The user widened this one question to the whole pool. */
  widened: boolean;
  /** The lens was on and the project's sources held nothing above the floor. */
  emptyInProject?: boolean;
}

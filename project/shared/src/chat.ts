import type { FileProcessingState, FileReadOutcome } from './files';
import type { MemoryScope, MemoryStatus } from './memory';
import type { ChatLensDto } from './projects';
import type { ChatSkillRunRef } from './skills';

/** Chat DTOs: POST /api/chat (SSE) and the persisted conversation. */

export interface ChatAskRequest {
  content: string;
  /** The conversation this message is sent to — it always lands there. */
  conversationId: string;
}

/**
 * A conversation: the workspace container in the chat
 * sidebar. Memory is the continuity, conversations are workspaces — what
 * Cogeto learned in one conversation is available in every other through
 * memory retrieval; only raw turn context is scoped to the thread.
 */
export interface ConversationDto {
  id: string;
  /** NULL until auto-titled (or renamed) — the UI shows "New conversation". */
  title: string | null;
  /** True after a manual rename — the auto-titler never overwrites it. */
  titleSetByUser: boolean;
  archived: boolean;
  createdAt: string;
  /** Last-message time — the sidebar's recency order. */
  updatedAt: string;
  /** First characters of the last message, for the sidebar preview. */
  lastMessagePreview: string | null;
  /**
   * The project this conversation is assigned to (V2.5 item 8.3), or null.
   * Assignment is organisation, never authorisation: it decides which
   * sources the retrieval lens narrows to, and nothing about visibility.
   */
  projectId: string | null;
}

/**
 * One conversation matched by search (issue #530). The snippet carries the
 * matched words wrapped in two control-character sentinels, so the client
 * renders the highlight by SPLITTING rather than by being handed markup to
 * inject.
 */
export interface ConversationSearchHitDto {
  conversationId: string;
  title: string | null;
  archived: boolean;
  /** The project it lives in, so a result still says where it belongs. */
  projectId: string | null;
  /** Last-message time, for the same recency label the rail shows. */
  updatedAt: string;
  /** The matching message, so the result can deep-link to that exact turn. */
  messageId: string | null;
  /** The matching line, sentinel-wrapped; null when only the title matched. */
  snippet: string | null;
  /** The title itself matched, which is worth saying when there is no line. */
  matchedTitle: boolean;
}

/** GET /api/chat/conversations/:id/messages — the house { items, total } page. */
export interface ChatMessagePage {
  items: ChatMessageDto[];
  total: number;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessageDto {
  id: string;
  role: ChatRole;
  content: string;
  /** The model's displayed deliberation (Part C of reasoning support), when a
   * reasoning model produced one. A CHANNEL, never content: not capturable,
   * not citable, not evaluated. Null for user rows and non-reasoning models. */
  thinking: string | null;
  /** The ambiguity decision behind a grounded assistant answer (V2.3 item
   * 6.3): which entity clusters were considered, their scores, and which
   * branch was taken. Null for user rows, non-grounded replies, and rows
   * older than the feature. Content-bearing (subject names), so the answer
   * redaction cascade clears it with the answer. */
  ambiguity: AmbiguityDecisionDto | null;
  /**
   * What the project retrieval lens did on this turn (V2.5 item 8.3), so
   * re-opening a conversation renders the same honest labels it showed live.
   * Identifiers and booleans, never a project name and never content. Null
   * for user rows, unlensed turns and rows older than the feature.
   */
  lens: ChatLensDto | null;
  createdAt: string;
}

/** The three deterministic outcomes of spec §7.5, in evaluation order. */
export type AmbiguityBranch = 'dominant' | 'silent' | 'fan_out';

/**
 * One candidate answer subject considered by the ambiguity decision: an
 * anchored-entity cluster over the post-fusion results (V2.3 item 6.3).
 */
export interface AmbiguityClusterDto {
  /** The display subject: the top member's anchored subject entity. Empty
   * for the unanchored bucket, which can never be a fan-out line. */
  subject: string;
  /** The alias-canonical folded cluster key; empty for the unanchored bucket. */
  key: string;
  /** Best member vector similarity, normalized [0,1]; 0 when no member was
   * surfaced by the vector signal. The relevance-floor input. */
  relevance: number;
  /** A member's subject or entities fold-match a query-named entity: the
   * identity lift that makes the cluster relevant whatever its similarity. */
  entityNamed: boolean;
  /** Max member fused score (RRF × status multiplier). The comparability input. */
  fused: number;
  /** Member count, recorded for diagnosis; never a score input. */
  size: number;
  /** The cluster's best fact — the one a fan-out line carries. */
  topMemoryId: string;
  /** True when this cluster produced a fan-out line. */
  shown: boolean;
}

/**
 * The recorded ambiguity decision (spec §7.5): stored on the assistant
 * message, carried on the live `done` event, inspectable later. Deterministic
 * arithmetic over scores retrieval already computed; no model call.
 */
export interface AmbiguityDecisionDto {
  branch: AmbiguityBranch;
  /** Every cluster considered, fused-score order. */
  clusters: AmbiguityClusterDto[];
  /** Cluster keys the question itself named (rule 1); empty otherwise. */
  named: string[];
  /** True when more clusters qualified for the fan-out than were shown. */
  capped: boolean;
  /** AMBIGUITY_CONFIG_VERSION in force when the decision was made. */
  configVersion: number;
  /** The embedding model whose calibrated thresholds applied. */
  embeddingModel: string;
}

/**
 * One retrieved fact in the answer context. `marker` is the inline citation
 * token the model uses ("F1"); persisted assistant messages carry the stable
 * form `[[mem:<memoryId>]]` instead, so history keeps working when the live
 * sources list is gone.
 */
export interface ChatFactDto {
  marker: string;
  memoryId: string;
  claim: string | null;
  status: MemoryStatus;
  /** Scope of the cited fact: a `shared` fact owned by another org
   * member is attributed to them in the chip. */
  scope: MemoryScope;
  /** The owning user's id and display name — null name when unresolved. */
  ownerId: string;
  ownerName: string | null;
  sensitive: boolean;
  /** The entity this fact is primarily ABOUT (F1/F4); null pre-v0002. */
  subjectEntity: string | null;
  sourceType: string;
  sourceId: string;
  validFrom: string | null;
  validUntil: string | null;
  /** Which spec §3.4 retrieval signals surfaced this fact. */
  signals: string[];
  /**
   * Past belief: replaced/outdated, or interval
   * closed before now. The answer MUST frame such facts as past, and the UI
   * renders a muted "past" chip.
   */
  pastBelief: boolean;
  /** Successor pointer when this fact was superseded; null otherwise. */
  supersededBy: string | null;
}

/**
 * The research offer riding on a knowledge-class answer: a
 * one-tap suggestion that leads into the existing minimise-and-approve gate.
 * The offer is the bridge; the gate stays the gate — tapping it only PROPOSES
 * a run (nothing leaves until approval on the Research page). Ephemeral: it
 * accompanies the live answer and is not persisted.
 */
export interface ChatResearchOffer {
  /** The self-contained topic the proposal would minimise and disclose. */
  topic: string;
}

/**
 * A research turn's proposal handle: lets the chat surface
 * open the SAME show-edit-approve gate inline. Carrying only the run id keeps
 * the disclosure in one place — the SPA loads the run through the owner-gated
 * research endpoints, exactly as the Research page does. Ephemeral, like the
 * offer.
 */
export interface ChatResearchProposalRef {
  runId: string;
}

/**
 * The widen offer (V2.5 item 8.3): the lens found nothing in this project and
 * the answer said so. Tapping re-asks the SAME question with the lens off for
 * that one turn; the conversation stays in its project and the next question
 * is lensed again.
 */
export interface ChatWidenOffer {
  projectId: string;
  /** The question to re-ask, so the client never has to reconstruct it. */
  question: string;
}

/** Server-sent events on POST /api/chat, in order: sources → token* → done. */
export type ChatStreamEvent =
  /** A reasoning delta (Part C): displayed live in the collapsed Thinking
   * disclosure. Interleaves with `token` events; absent entirely for a
   * non-reasoning model. */
  | { type: 'thinking'; text: string }
  | { type: 'sources'; facts: ChatFactDto[] }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      messageId: string;
      content: string;
      /** Non-conforming citation tokens stripped from this answer (metadata only). */
      citationViolations: number;
      /** Present on knowledge-class answers when research is available (0046). */
      researchOffer?: ChatResearchOffer | null;
      /** Present on a research turn that proposed a run (0047): the inline
       * gate's handle. Nothing has been sent when this arrives. */
      researchProposal?: ChatResearchProposalRef | null;
      /** Present on a skill turn that proposed a run: the run
       * view's handle. Nothing has been sent when this arrives — the plan
       * gate lives on the run view. */
      skillRun?: ChatSkillRunRef | null;
      /** The ambiguity decision behind this answer (V2.3 item 6.3), when the
       * grounded path computed one. Mirrors the stored record. */
      ambiguity?: AmbiguityDecisionDto | null;
      /** What the project retrieval lens did on this turn (V2.5 item 8.3).
       * Mirrors the stored record. */
      lens?: ChatLensDto | null;
      /** Present when the lens was applied and the project's sources held
       * nothing above the relevance floor: the one-tap widen offer. Cogeto
       * never widens silently, so this offer IS the bridge (the research
       * rule, applied to the lens). Ephemeral, like the research offer. */
      widenOffer?: ChatWidenOffer | null;
    }
  | {
      type: 'error';
      message: string;
      /** Machine-readable cause when the client should surface a specific
       * message: `model_budget_exceeded` (daily cap), `timeout` (idle/max
       * duration abort). Absent for a generic failure. */
      code?: 'model_budget_exceeded' | 'timeout';
    };

/**
 * The honest in-flight stage of a source's pipeline run (V2.2 item 5.1),
 * mirroring the stages the pipeline actually reports: reading the bytes,
 * extracting facts, verifying them against their spans, storing and
 * reconciling. Terminal state comes from the queue's ledgers, not from here.
 */
export type IngestionStage = 'reading' | 'extracting' | 'verifying' | 'storing';

/**
 * One file attached in a conversation (V2.2 item 5.1). Durable attachments
 * ARE ordinary file sources (same pipeline, same provenance); this DTO is the
 * conversation's view of one: the link, the honest progress, and the settled
 * outcome with real numbers. Transient attachments never become sources; their
 * text serves this conversation only.
 */
export interface ChatAttachmentDto {
  id: string;
  conversationId: string;
  /** The user message it was sent with; null for an attachment sent alone. */
  messageId: string | null;
  transient: boolean;
  /** Display name; null once the source (and with it the filename) was erased. */
  name: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  /**
   * Durable: the pipeline job state (`processing` | `done` | `error`).
   * Transient: `processing` while the read job runs, `done` when the text is
   * ready, `error` when the bytes could not be read.
   */
  state: FileProcessingState;
  /** The in-flight pipeline stage while `state` is `processing`, when known. */
  stage: IngestionStage | null;
  /** Durable: the file source's object key — the link into Sources. Null for
   * transient attachments and after the source was deleted. */
  objectKey: string | null;
  /** What the reading layer made of the bytes, once settled. */
  readOutcome: FileReadOutcome | null;
  /** The read report's reason code for an unreadable file, once settled. */
  readReason: string | null;
  /** Durable, settled: facts admitted from this source. */
  factsCount: number | null;
  /** Durable, settled: open contradictions this source's facts are party to. */
  contradictionsCount: number | null;
  /** Durable, settled: the extraction gate's refusal reason, when it refused. */
  gateRefusal: string | null;
  /** True when the durable file source was deleted after ingestion. */
  sourceDeleted: boolean;
  createdAt: string;
}

/** POST /api/chat/attachments — the created attachment. */
export interface ChatAttachmentCreatedDto {
  attachment: ChatAttachmentDto;
}

/** POST /api/chat/messages/:id/remember: the enqueued capture. */
export interface ChatRememberedDto {
  /** The chat_message id — the derived memories' `source_id`. */
  messageId: string;
}

/** One turn in a remembered message's source drawer (the chat provenance). */
export interface ChatContextTurn {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** The remembered message itself — the drawer highlights it. */
  isTarget: boolean;
}

/** GET /api/chat/messages/:id/context — the message plus surrounding turns. */
export interface ChatContextDto {
  turns: ChatContextTurn[];
  /** The conversation the remembered message lives in — the source
   * drawer frames the context with it and deep-links into the thread. */
  conversationId: string;
  /** The conversation's display title; null while untitled. */
  conversationTitle: string | null;
}

/** The sentinels wrapping matched words in a search snippet. Control
 * characters, so they cannot collide with anything a user typed and cannot be
 * mistaken for markup. */
export const SEARCH_MATCH_OPEN = '\u0001';
export const SEARCH_MATCH_CLOSE = '\u0002';

/**
 * Splits a sentinel-wrapped snippet into plain and matched runs, so a renderer
 * can emphasise the matches without ever interpreting the text as markup.
 */
export function splitSearchSnippet(snippet: string): { text: string; matched: boolean }[] {
  const parts: { text: string; matched: boolean }[] = [];
  const pattern = new RegExp(
    `${SEARCH_MATCH_OPEN}([^${SEARCH_MATCH_CLOSE}]*)${SEARCH_MATCH_CLOSE}`,
    'g',
  );
  let cursor = 0;
  for (const match of snippet.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push({ text: snippet.slice(cursor, at), matched: false });
    if (match[1]) parts.push({ text: match[1], matched: true });
    cursor = at + match[0].length;
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), matched: false });
  // Any stray sentinel that survived is stripped, never rendered.
  return parts
    .map((part) => ({
      ...part,
      text: part.text.replaceAll(SEARCH_MATCH_OPEN, '').replaceAll(SEARCH_MATCH_CLOSE, ''),
    }))
    .filter((part) => part.text.length > 0);
}

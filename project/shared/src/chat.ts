import type { MemoryScope, MemoryStatus } from './memory';

/** Chat DTOs (S3-A): POST /api/chat (SSE) and the persisted conversation. */

export interface ChatAskRequest {
  content: string;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessageDto {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
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
  /** Scope of the cited fact (O2-B): a `shared` fact owned by another org
   * member is attributed to them in the chip. */
  scope: MemoryScope;
  /** The owning user's id and display name (O2-B) — null name when unresolved. */
  ownerId: string;
  ownerName: string | null;
  sensitive: boolean;
  /** The entity this fact is primarily ABOUT (F1/F4); null pre-v0002. */
  subjectEntity: string | null;
  sourceType: string;
  sourceId: string;
  validFrom: string | null;
  validUntil: string | null;
  /** Which §A.5 retrieval signals surfaced this fact. */
  signals: string[];
  /**
   * Past belief (decision 0012 ruling 6): replaced/outdated, or interval
   * closed before now. The answer MUST frame such facts as past, and the UI
   * renders a muted "past" chip.
   */
  pastBelief: boolean;
  /** Successor pointer when this fact was superseded; null otherwise. */
  supersededBy: string | null;
}

/** Server-sent events on POST /api/chat, in order: sources → token* → done. */
export type ChatStreamEvent =
  | { type: 'sources'; facts: ChatFactDto[] }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      messageId: string;
      content: string;
      /** Non-conforming citation tokens stripped from this answer (metadata only). */
      citationViolations: number;
    }
  | { type: 'error'; message: string };

/** POST /api/chat/messages/:id/remember (decision 0021): the enqueued capture. */
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
}

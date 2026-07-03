import type { MemoryStatus } from './memory';

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
  sensitive: boolean;
  /** The entity this fact is primarily ABOUT (F1/F4); null pre-v0002. */
  subjectEntity: string | null;
  sourceType: string;
  sourceId: string;
  validFrom: string | null;
  validUntil: string | null;
  /** Which §A.5 retrieval signals surfaced this fact. */
  signals: string[];
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

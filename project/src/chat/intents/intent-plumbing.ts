import type { AmbiguityDecisionDto, ChatLensDto, Principal } from '@cogeto/shared';
import type { PromptArtifact } from '../../model-gateway/index';

/**
 * What every intent handler needs from the orchestrator (V2.0 item 3.6
 * part 4): the one write path for assistant replies (which also bumps the
 * sidebar and requests the auto-title), the shared answer prompt, and a
 * content-free warning channel. Handlers stay plain classes constructed by
 * ChatService — they are the service's decomposition, not new DI surface, so
 * the composition graph is unchanged.
 */
export interface ChatTurnSink {
  storeAssistant(
    principal: Principal,
    conversationId: string,
    content: string,
    /** The displayed deliberation (Part C); null when the model produced none. */
    thinking?: string | null,
    /** The ambiguity decision behind a grounded answer (V2.3 item 6.3);
     * null when the path computed none. */
    ambiguity?: AmbiguityDecisionDto | null,
    /** What the project retrieval lens did on this turn (V2.5 item 8.3);
     * null when no lens applied, which is every unassigned conversation. */
    lens?: ChatLensDto | null,
    /** The user stopped this answer (issue #532): stored by the SAME path as
     * a complete one, because a second write path for partials is how the two
     * drift apart. */
    stopped?: boolean,
  ): Promise<{ id: string }>;
  getPrompt(): Promise<PromptArtifact>;
  /**
   * The conversation's current focus subject (issue #479, layer 3), or null.
   * Read before the answer call so a pronoun still binds after a digression.
   */
  readFocus(conversationId: string): Promise<{ subject: string; setAt: Date } | null>;
  /**
   * Remember what this turn resolved. Called only when a subject was genuinely
   * resolved; a score-derived guess must never become the conversation's
   * memory of what it is about.
   */
  writeFocus(conversationId: string, subject: string): Promise<void>;
  /**
   * The answer model this user chose for themselves (V2.4 item 7.1), as the
   * opaque option id an admin enabled, or null for the instance's assigned
   * answer tier. Null is what every instance returns until an admin enables a
   * set, which keeps the answer call byte-identical to what it was.
   */
  answerOptionFor(userId: string): Promise<string | null>;
  /** Metadata only — never answer content or tokens (pino rule). */
  logWarn(message: string): void;
}

/**
 * The router's order, as DATA. Behaviour used to depend on where each guard
 * sat inside a 900-line ask(); the orchestrator now names the sequence and
 * `chat-routing.spec.ts` asserts BOTH this list and the observable precedence
 * (an input matching two intents resolves to the earlier one). Reordering
 * this array is a behaviour change and fails the spec.
 */
export const CHAT_ROUTING_ORDER = [
  'small_talk_lexicon',
  'skill_brief',
  'research',
  'router_rewrite',
  'model_small_talk',
  'reply_draft',
  'memory_answer',
] as const;

export type ChatRoutingStep = (typeof CHAT_ROUTING_ORDER)[number];

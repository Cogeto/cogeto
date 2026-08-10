import type { AmbiguityDecisionDto } from '@cogeto/shared';

/**
 * WHAT IS THIS TURN ABOUT (issue #479). One pure function, because the whole
 * point of the change is that the subject is DECIDED, not re-derived: a model
 * asked to work it out a second time gets a second chance to be wrong, and did.
 *
 * The pipeline already knows. The rewriter resolves the reference, retrieval
 * uses the resolved form, and the ambiguity rule records which cluster the
 * question named. That conclusion used to be written to
 * `chat_message.ambiguity` for diagnostics and then dropped before the answer
 * call. This reads it back out.
 *
 * Design: docs/features/ambiguity.md and the prompt artifact answer/v0009.
 */

/**
 * How long a conversation focus keeps binding pronouns. Twelve hours is a
 * working session with a break in it: long enough that lunch does not lose the
 * thread, short enough that tomorrow morning's "how does it look" is not
 * silently answered about yesterday's part.
 *
 * A stale focus is DROPPED, never used with a warning: an assumption the user
 * cannot see is worse than no assumption, because the honest fallback (say
 * which subject you chose) is already in the prompt.
 */
export const FOCUS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface ConversationFocus {
  subject: string;
  setAt: Date;
}

export interface ResolvedSubject {
  /** The display subject to state in the prompt; null asserts nothing. */
  about: string | null;
  /** True when it came from the stored focus rather than from this turn. */
  carriedOver: boolean;
  /** The focus to persist after this turn, or null to leave it untouched. */
  focusToStore: string | null;
}

/**
 * The subject THIS turn resolved, from the ambiguity decision.
 *
 * Only `named` counts. It is the record of rule 1, "the question's own naming
 * outranks similarity": the query named the subject, or a fan-out follow-up
 * settled it. Everything else in the decision is score-derived, and a subject
 * asserted from a score is a subject nobody resolved.
 *
 * Several named clusters is a comparison ("M557 versus SEN-210"), not one
 * subject, so nothing is asserted: the question already names both and the
 * answerer can read them.
 */
function subjectNamedThisTurn(decision: AmbiguityDecisionDto | null): string | null {
  if (!decision || decision.named.length !== 1) return null;
  const key = decision.named[0]!;
  // The decision carries folded keys; the prompt wants the display subject a
  // human wrote. Fall back to the key only if no cluster carries a subject.
  const cluster = decision.clusters.find((c) => c.key === key);
  const subject = (cluster?.subject ?? '').trim();
  return subject.length > 0 ? subject : key.trim() || null;
}

/**
 * Resolve the subject for one turn, and decide what the conversation should
 * remember afterwards.
 *
 * Precedence, and the reason for each step:
 *
 * 1. **This turn named a subject.** Strongest evidence there is, and it becomes
 *    the new focus.
 * 2. **The stored focus, if fresh.** The turn resolved nothing of its own, so
 *    the last thing the conversation was about is the working assumption. The
 *    prompt renders it as carried over, so the answerer treats it as
 *    correctable rather than as something the user just said.
 * 3. **Nothing.** No subject line is emitted, and answer/v0009 tells the model
 *    to choose from the question and facts AND to say which subject it chose.
 *    Silence here is honest; a guess dressed as a decision is not.
 */
export function resolveAnswerSubject(
  decision: AmbiguityDecisionDto | null,
  focus: ConversationFocus | null,
  now: Date,
): ResolvedSubject {
  const named = subjectNamedThisTurn(decision);
  if (named) {
    // Re-storing the same subject still refreshes `setAt`: an active thread
    // should not go stale mid-conversation.
    return { about: named, carriedOver: false, focusToStore: named };
  }
  if (focus && now.getTime() - focus.setAt.getTime() <= FOCUS_MAX_AGE_MS) {
    return { about: focus.subject, carriedOver: true, focusToStore: null };
  }
  return { about: null, carriedOver: false, focusToStore: null };
}

/**
 * The last few exchanges for the answer input, oldest first.
 *
 * Deliberately small. This block is fenced and competes with the facts for
 * attention, and its job is narrow: the discourse a subject line cannot carry
 * ("what about the other one", "and in metric"). The subject line does the
 * heavy lifting; this is the remainder.
 */
export const RECENT_TURNS_FOR_ANSWER = 4;

export function recentTurnsForAnswer<T extends { role: string; content: string }>(
  history: readonly T[],
): { role: string; content: string }[] {
  return history
    .slice(-RECENT_TURNS_FOR_ANSWER)
    .map((turn) => ({ role: turn.role, content: turn.content }));
}

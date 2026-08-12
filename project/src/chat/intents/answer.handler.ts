import type {
  AmbiguityDecisionDto,
  ChatFactDto,
  ChatLensDto,
  ChatStreamEvent,
  ChatWidenOffer,
  Principal,
} from '@cogeto/shared';
import { hasProfileContext } from '../../infrastructure/index';
import type { UserContextRecord } from '../../infrastructure/index';
import { isPastBelief } from '../../memory/index';
import type { ModelGateway } from '../../model-gateway/index';
import type { UserDirectory } from '../../identity/index';
import type {
  ConversationTurn,
  RetrievalService,
  RetrievedMemory,
  RewriteResult,
} from '../../retrieval/index';
import { buildAnswerInput, nothingOnRecord, nothingOpen, toStoredAnswer } from '../answer-prompt';
import type { AnswerAttachment } from '../answer-prompt';
import {
  buildFanoutAnswer,
  matchOfferedSubjects,
  nothingInProject,
  silentPreamble,
} from '../fanout-answer';
import { recentTurnsForAnswer, resolveAnswerSubject } from '../answer-subject';
import type { ChatTurnSink } from './intent-plumbing';

/** How many facts the answer context receives (wider so aggregation fits, F5). */
const ANSWER_FACTS_TOP_K = 12;

/**
 * The memory/knowledge answer path (V2.0 item 3.6 part 4, extracted verbatim
 * from chat.service.ts): memory-first retrieval for BOTH personal and
 * knowledge questions — grounded facts always come first; general knowledge
 * supplements, marked, never replaces. Includes the zero-retrieval honesty
 * paths and the research offer on knowledge-class answers.
 *
 * Since V2.3 item 6.3 the retrieval result carries the spec §7.5 ambiguity
 * decision, and this handler renders its three behaviours: `dominant` answers
 * exactly as before, `silent` states the corpus is silent before any general
 * knowledge, `fan_out` produces the deterministic one-line-per-subject answer
 * ending with the disambiguating question. Design:
 * docs/features/ambiguity.md.
 */
export class MemoryAnswerHandler {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly gateway: ModelGateway,
    private readonly directory: UserDirectory,
    private readonly sink: ChatTurnSink,
    /** Whether the research seam is wired — the offer only renders then. */
    private readonly researchAvailable: () => boolean,
  ) {}

  async *handle(
    principal: Principal,
    conversationId: string,
    content: string,
    history: ConversationTurn[],
    rewrite: RewriteResult,
    context: {
      record: UserContextRecord;
      answerBlock: string;
      /** Transient conversation attachments (V2.2 item 5.1), fenced ground. */
      attachments?: AnswerAttachment[];
      /** The previous assistant turn's ambiguity decision, when it exists:
       * how a fan-out's "which did you mean?" reply resolves without
       * re-fanning (V2.3 item 6.3). */
      priorAmbiguity?: AmbiguityDecisionDto | null;
      /**
       * The project retrieval lens for this turn (V2.5 item 8.3), already
       * resolved by the orchestrator, or null for an unassigned conversation
       * (and for a turn the user widened). A FILTER over sources; nothing
       * here decides visibility.
       */
      lens?: {
        projectId: string;
        projectName: string;
        sourceRefs: readonly { sourceType: string; sourceId: string }[];
      } | null;
      /** Set when the user widened THIS question out of that project: the
       * conversation stays in its project and the next question is lensed
       * again. Recorded so the stored message says so honestly. */
      widenedFrom?: string | null;
      /** Fires when the user presses Stop (issue #532). Passed to the model
       * call so generation ends, and read here to tell a deliberate stop
       * apart from a provider failure. */
      stopSignal?: AbortSignal;
    },
    thinkingMode: 'on' | 'off' = 'on',
  ): AsyncGenerator<ChatStreamEvent> {
    const attachments = context.attachments ?? [];
    const knowledge = rewrite.questionClass === 'knowledge';
    const lang = context.record.preferredLanguage;

    // Deterministic fan-out follow-up resolution: a reply naming an offered
    // subject makes that subject a query entity, so the decision rule's
    // "named subject wins" resolves it — no re-fanning, no model call.
    const offered = matchOfferedSubjects(content, context.priorAmbiguity);
    const effectiveRewrite =
      offered.length > 0
        ? { ...rewrite, entities: [...new Set([...rewrite.entities, ...offered])] }
        : rewrite;

    const lens = context.lens ?? null;
    let lensRecord: ChatLensDto | null = lens
      ? { projectId: lens.projectId, applied: true, widened: false }
      : context.widenedFrom
        ? { projectId: context.widenedFrom, applied: false, widened: true }
        : null;
    let widenOffer: ChatWidenOffer | null = null;

    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
      history,
      rewrite: effectiveRewrite,
      ambiguity: true,
      // The lens narrows the CANDIDATE SET; the spec §7.5 decision rule and
      // every threshold are unchanged (V2.5 item 8.3), so a fan-out inside a
      // project fans only across subjects the project holds.
      ...(lens ? { lens: lens.sourceRefs } : {}),
    });
    const decision = retrieved.ambiguity ?? null;
    const facts = retrieved.memories.map((hit, i) => toFactDto(hit, i));

    // FAN OUT (spec §7.5.3): fully server-authored — one line per cluster
    // with the best fact verbatim and its real citation, capped honestly,
    // ending with the disambiguating question. Never a silent guess, never a
    // bare clarifying question.
    if (decision?.branch === 'fan_out') {
      const factsById = new Map(facts.map((fact) => [fact.memoryId, fact]));
      const shown = decision.clusters
        .filter((cluster) => cluster.shown)
        .map((cluster) => factsById.get(cluster.topMemoryId))
        .filter((fact): fact is ChatFactDto => fact !== undefined);
      await this.resolveOwnerNames(shown);
      yield { type: 'sources', facts: shown };
      const answer = buildFanoutAnswer(decision, factsById, lang);
      yield { type: 'token', text: answer };
      yield* this.finish(principal, conversationId, answer, '', shown, decision, null, lensRecord);
      return;
    }

    const silent = decision?.branch === 'silent';
    // THE LENS GAP (V2.5 item 8.3). The project's sources hold nothing above
    // the relevance floor. Cogeto does not widen silently (the frozen
    // research rule: the offer is the bridge, the gate stays the gate) and
    // does not refuse silently either: it names the project it looked in and
    // offers the one-tap widen beside the answer. A knowledge-class question
    // keeps its general-knowledge path below, with a preamble that names the
    // project rather than claiming the whole corpus is silent.
    // The two extra guards make this a strict REFINEMENT of the
    // nothing-on-record branch below rather than a new short-circuit in front
    // of it: profile context and a transient attachment are provided ground
    // that has nothing to do with a project's sources, and a lens must never
    // take an answer away that the unlensed path would have given.
    if (
      lens &&
      (facts.length === 0 || silent) &&
      !knowledge &&
      retrieved.mode !== 'open_loops' &&
      !hasProfileContext(context.record) &&
      attachments.length === 0
    ) {
      lensRecord = { ...lensRecord!, emptyInProject: true };
      widenOffer = { projectId: lens.projectId, question: content };
      yield { type: 'sources', facts: [] };
      const answer = nothingInProject(lang, lens.projectName);
      yield { type: 'token', text: answer };
      yield* this.finish(
        principal,
        conversationId,
        answer,
        '',
        [],
        decision,
        null,
        lensRecord,
        widenOffer,
      );
      return;
    }
    // The corpus is silent and nothing else grounds an answer: the
    // deterministic honesty path, now reached over sub-floor noise too, not
    // only on zero rows.
    if (
      (facts.length === 0 || silent) &&
      !knowledge &&
      retrieved.mode !== 'open_loops' &&
      !hasProfileContext(context.record) &&
      attachments.length === 0
    ) {
      yield { type: 'sources', facts: [] };
      const answer = nothingOnRecord(lang);
      yield { type: 'token', text: answer };
      yield* this.finish(principal, conversationId, answer, '', [], decision, null, lensRecord);
      return;
    }

    // SILENT + knowledge (spec §7.5.2): say the sources hold nothing, THEN
    // general knowledge under the explicit [U] marking. The sub-floor facts
    // are withheld from the model so it cannot cite something the preamble
    // just disclaimed; the considered clusters stay on the decision record.
    const silentKnowledge = silent && knowledge;
    const promptFacts = silentKnowledge ? [] : facts;
    await this.resolveOwnerNames(promptFacts);
    yield { type: 'sources', facts: promptFacts };

    let answer: string;
    let thinking = '';
    // STOP (issue #532). The signal reaches the provider, so the call ends
    // rather than merely going unread; the abort surfaces as a throw from the
    // stream. What was written is kept and stored by the ORDINARY path below,
    // flagged, because a truncated answer that looks complete reads as a bug.
    let stopped = false;
    if (retrieved.mode === 'open_loops' && (retrieved.openLoops?.length ?? 0) === 0) {
      // Zero open loops is an ANSWER (all clear), not a data gap. A
      // deterministic string cannot mirror; it follows the anchor (0052).
      answer = nothingOpen(lang);
      yield { type: 'token', text: answer };
    } else {
      let preamble = '';
      if (silentKnowledge) {
        preamble = silentPreamble(lang, lens?.projectName ?? null);
        yield { type: 'token', text: `${preamble}\n\n` };
      }
      const prompt = await this.sink.getPrompt();
      // WHAT THE QUESTION IS ABOUT (issue #479). The pipeline already decided
      // this; reading it back out is the entire fix. A model asked to
      // re-derive the referent from the fact block does so by elimination and
      // hedges when elimination is ambiguous, which is what shipped before.
      const focus = await this.sink.readFocus(conversationId).catch(() => null);
      const subject = resolveAnswerSubject(decision, focus, new Date());
      if (subject.focusToStore) {
        await this.sink
          .writeFocus(conversationId, subject.focusToStore)
          .catch(() => this.sink.logWarn('conversation focus not stored'));
      }
      let buffer = '';
      // The user's own answer model (V2.4 item 7.1). An opaque option id from
      // the set an admin enabled, never a vendor model string: the call site
      // still names a tier and the seam still owns the mapping (spec §12.1).
      const answerOption = await this.sink.answerOptionFor(principal.userId);
      const stream = this.gateway.completeStream({
        system: prompt.content,
        ...(answerOption ? { answerOption } : {}),
        input: buildAnswerInput(promptFacts, content, retrieved.mode, {
          temporal: retrieved.temporal,
          changes: retrieved.changes,
          openLoops: retrieved.openLoops,
          knowledge,
          context: context.answerBlock,
          attachments,
          about: subject.about ?? undefined,
          aboutCarriedOver: subject.carriedOver,
          resolvedQuestion: effectiveRewrite.query,
          // The recent turns are WITHHELD on the silent path, for the same
          // reason the sub-floor facts are (spec §7.5.2). The preamble has
          // just told the user the sources hold nothing; an earlier assistant
          // turn quoting one of those facts would put it straight back in
          // front of the model, which could then restate a disclaimed claim as
          // known. A prior turn is not a citable source, so it may not be the
          // route by which a withheld fact returns.
          //
          // `about` survives: a subject NAME is not a claim, and knowing which
          // subject the user means is what lets the answer say "I have nothing
          // about the M557" instead of a bare shrug.
          recentTurns: silentKnowledge ? undefined : recentTurnsForAnswer(history),
        }),
        tier: 'answer',
        thinking: thinkingMode,
        ...(context.stopSignal ? { signal: context.stopSignal } : {}),
      });
      // Two channels, two fates (Part C): thinking streams to the disclosure
      // and is stored BESIDE the answer; only the text channel becomes the
      // answer — it alone is sanitized, cited, capturable, and evaluated.
      try {
        for await (const delta of stream) {
          if (delta.channel === 'thinking') {
            thinking += delta.text;
            yield { type: 'thinking', text: delta.text };
            continue;
          }
          buffer += delta.text;
          yield { type: 'token', text: delta.text };
        }
      } catch (error) {
        // Only OUR stop is swallowed. A real provider failure still throws,
        // because presenting a failed generation as a stopped one would hide
        // an error behind a user action.
        if (!context.stopSignal?.aborted) throw error;
        stopped = true;
      }
      // Nothing but thinking was produced: there is no answer to keep, so the
      // turn is dropped rather than stored as an empty bubble.
      if (stopped && buffer.trim().length === 0) {
        yield { type: 'done', messageId: '', content: '', citationViolations: 0, stopped: true };
        return;
      }
      answer = preamble ? `${preamble}\n\n${buffer}` : buffer;
    }

    // The research offer: every knowledge-class answer OFFERS
    // research as a one-tap bridge into the existing gate — never a silent
    // search. The offer carries the self-contained topic; tapping it proposes.
    const researchOffer = knowledge && this.researchAvailable() ? { topic: rewrite.query } : null;
    yield* this.finish(
      principal,
      conversationId,
      answer,
      thinking,
      promptFacts,
      decision,
      researchOffer,
      lensRecord,
      widenOffer,
      stopped,
    );
  }

  /** Sanitize, store (answer + thinking + decision), and close the turn. */
  private async *finish(
    principal: Principal,
    conversationId: string,
    answer: string,
    thinking: string,
    facts: ChatFactDto[],
    decision: AmbiguityDecisionDto | null,
    researchOffer: { topic: string } | null,
    lens: ChatLensDto | null = null,
    widenOffer: ChatWidenOffer | null = null,
    stopped = false,
  ): AsyncGenerator<ChatStreamEvent> {
    const { text: stored, violations } = toStoredAnswer(answer, facts);
    if (violations > 0 && !stopped) {
      // Metadata only — never the answer content or tokens (pino rule).
      // A STOPPED answer is skipped: truncating mid-marker (`[F`) is a
      // guaranteed "violation" that says nothing about the model, and
      // counting it would make the metric meaningless the moment Stop is used.
      this.sink.logWarn(`citation_violation stripped=${violations}`);
    }
    const row = await this.sink.storeAssistant(
      principal,
      conversationId,
      stored,
      thinking.trim() ? thinking : null,
      decision,
      lens,
      stopped,
    );
    yield {
      type: 'done',
      messageId: row.id,
      content: stored,
      citationViolations: violations,
      researchOffer,
      ambiguity: decision,
      lens,
      widenOffer,
      stopped,
    };
  }

  /** Attribute cited shared facts to their owner — name-only; the gates
   * already decided these were visible to the caller. */
  private async resolveOwnerNames(facts: ChatFactDto[]): Promise<void> {
    if (facts.length === 0) return;
    const names = await this.directory.displayNames(facts.map((f) => f.ownerId));
    for (const fact of facts) fact.ownerName = names.get(fact.ownerId) ?? null;
  }
}

function toFactDto(hit: RetrievedMemory, index: number): ChatFactDto {
  return {
    marker: `F${index + 1}`,
    memoryId: hit.memory.id,
    claim: hit.memory.content,
    status: hit.memory.status,
    scope: hit.memory.scope,
    ownerId: hit.memory.ownerId,
    ownerName: null,
    sensitive: hit.memory.sensitive,
    subjectEntity: hit.memory.subjectEntity,
    sourceType: hit.memory.sourceType,
    sourceId: hit.memory.sourceId,
    validFrom: hit.memory.validFrom?.toISOString() ?? null,
    validUntil: hit.memory.validUntil?.toISOString() ?? null,
    signals: hit.signals,
    // The past-framing data contract: computed here,
    // consumed by the answer prompt AND the UI chip — testable without a model.
    pastBelief: isPastBelief(hit.memory),
    supersededBy: hit.memory.supersededBy,
  };
}

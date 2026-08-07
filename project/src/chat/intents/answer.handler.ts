import type { AmbiguityDecisionDto, ChatFactDto, ChatStreamEvent, Principal } from '@cogeto/shared';
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
import { buildFanoutAnswer, matchOfferedSubjects, silentPreamble } from '../fanout-answer';
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

    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
      history,
      rewrite: effectiveRewrite,
      ambiguity: true,
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
      yield* this.finish(principal, conversationId, answer, '', shown, decision, null);
      return;
    }

    const silent = decision?.branch === 'silent';
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
      yield* this.finish(principal, conversationId, answer, '', [], decision, null);
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
    if (retrieved.mode === 'open_loops' && (retrieved.openLoops?.length ?? 0) === 0) {
      // Zero open loops is an ANSWER (all clear), not a data gap. A
      // deterministic string cannot mirror; it follows the anchor (0052).
      answer = nothingOpen(lang);
      yield { type: 'token', text: answer };
    } else {
      let preamble = '';
      if (silentKnowledge) {
        preamble = silentPreamble(lang);
        yield { type: 'token', text: `${preamble}\n\n` };
      }
      const prompt = await this.sink.getPrompt();
      let buffer = '';
      const stream = this.gateway.completeStream({
        system: prompt.content,
        input: buildAnswerInput(promptFacts, content, retrieved.mode, {
          temporal: retrieved.temporal,
          changes: retrieved.changes,
          openLoops: retrieved.openLoops,
          knowledge,
          context: context.answerBlock,
          attachments,
        }),
        tier: 'answer',
        thinking: thinkingMode,
      });
      // Two channels, two fates (Part C): thinking streams to the disclosure
      // and is stored BESIDE the answer; only the text channel becomes the
      // answer — it alone is sanitized, cited, capturable, and evaluated.
      for await (const delta of stream) {
        if (delta.channel === 'thinking') {
          thinking += delta.text;
          yield { type: 'thinking', text: delta.text };
          continue;
        }
        buffer += delta.text;
        yield { type: 'token', text: delta.text };
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
  ): AsyncGenerator<ChatStreamEvent> {
    const { text: stored, violations } = toStoredAnswer(answer, facts);
    if (violations > 0) {
      // Metadata only — never the answer content or tokens (pino rule).
      this.sink.logWarn(`citation_violation stripped=${violations}`);
    }
    const row = await this.sink.storeAssistant(
      principal,
      conversationId,
      stored,
      thinking.trim() ? thinking : null,
      decision,
    );
    yield {
      type: 'done',
      messageId: row.id,
      content: stored,
      citationViolations: violations,
      researchOffer,
      ambiguity: decision,
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

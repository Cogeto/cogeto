import type { ChatFactDto, ChatStreamEvent, Principal } from '@cogeto/shared';
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
import type { ChatTurnSink } from './intent-plumbing';

/** How many facts the answer context receives (wider so aggregation fits, F5). */
const ANSWER_FACTS_TOP_K = 12;

/**
 * The memory/knowledge answer path (V2.0 item 3.6 part 4, extracted verbatim
 * from chat.service.ts): memory-first retrieval for BOTH personal and
 * knowledge questions — grounded facts always come first; general knowledge
 * supplements, marked, never replaces. Includes the zero-retrieval honesty
 * paths and the research offer on knowledge-class answers.
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
    },
    thinkingMode: 'on' | 'off' = 'on',
  ): AsyncGenerator<ChatStreamEvent> {
    const attachments = context.attachments ?? [];
    const knowledge = rewrite.questionClass === 'knowledge';
    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
      history,
      rewrite,
    });
    const facts = retrieved.memories.map((hit, i) => toFactDto(hit, i));
    // Attribute cited shared facts to their owner — name-only; the gates
    // already decided these were visible to the caller.
    const names = await this.directory.displayNames(facts.map((f) => f.ownerId));
    for (const fact of facts) fact.ownerName = names.get(fact.ownerId) ?? null;
    yield { type: 'sources', facts };

    let answer: string;
    let thinking = '';
    if (retrieved.mode === 'open_loops' && (retrieved.openLoops?.length ?? 0) === 0) {
      // Zero open loops is an ANSWER (all clear), not a data gap. A
      // deterministic string cannot mirror; it follows the anchor (0052).
      answer = nothingOpen(context.record.preferredLanguage);
      yield { type: 'token', text: answer };
    } else if (
      facts.length === 0 &&
      !knowledge &&
      !hasProfileContext(context.record) &&
      attachments.length === 0
    ) {
      // The zero-retrieval path: no model call, no generation from thin air.
      // With profile context set, the model DOES answer: the
      // settings are provided ground ("where do I work?" deserves the honest
      // "you've set … in Settings" reply), the honest-gap rules still hold,
      // and the sanitizer still strips any invented citation. A transient
      // attachment is provided ground the same way (V2.2 item 5.1): a
      // question about the attached file deserves an answer from it.
      answer = nothingOnRecord(context.record.preferredLanguage);
      yield { type: 'token', text: answer };
    } else {
      const prompt = await this.sink.getPrompt();
      let buffer = '';
      const stream = this.gateway.completeStream({
        system: prompt.content,
        input: buildAnswerInput(facts, content, retrieved.mode, {
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
      answer = buffer;
    }

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
    );
    // The research offer: every knowledge-class answer OFFERS
    // research as a one-tap bridge into the existing gate — never a silent
    // search. The offer carries the self-contained topic; tapping it proposes.
    const researchOffer = knowledge && this.researchAvailable() ? { topic: rewrite.query } : null;
    yield {
      type: 'done',
      messageId: row.id,
      content: stored,
      citationViolations: violations,
      researchOffer,
    };
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

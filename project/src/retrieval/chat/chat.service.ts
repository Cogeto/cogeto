import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import type { ChatFactDto, ChatMessageDto, ChatStreamEvent, Principal } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db } from '../../infrastructure/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { RetrievalService } from '../retrieval.service';
import type { RetrievedMemory } from '../retrieval.service';
import type { ConversationTurn } from '../query-rewrite';
import { chatMessage } from '../persistence/tables';
import {
  ANSWER_PROMPT,
  buildAnswerInput,
  NOTHING_ON_RECORD,
  toStoredAnswer,
} from './answer-prompt';

/** How many facts the answer context receives (wider so aggregation fits, F5). */
const ANSWER_FACTS_TOP_K = 12;
/** How much history the chat page loads. */
const HISTORY_LIMIT = 200;
/** Turns of prior conversation the rewriter sees to resolve references (F3). */
const REWRITE_HISTORY_TURNS = 6;

/**
 * The chat area (S3-A). Strictly fast path (§A.3): persist → retrieve →
 * generate — deliberately NO outbox enqueue and no ingestion-stage work.
 * Chat-derived memories are a later feature; when they arrive, the persisted
 * chat_message rows are their §A.6 provenance targets.
 *
 * Both writes are plain inserts to the module's own table; sensitive memories
 * stay excluded (no opt-in surface in chat v1 — decision 0003 ruling 3).
 */
@Injectable()
export class ChatService {
  private prompt?: PromptArtifact;
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly retrieval: RetrievalService,
    private readonly gateway: ModelGateway,
  ) {}

  async listMessages(principal: Principal): Promise<ChatMessageDto[]> {
    const rows = await this.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.ownerId, principal.userId))
      .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id))
      .limit(HISTORY_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * One question → one SSE stream: sources first (the frontend builds its
   * citation map before tokens arrive), then token deltas, then done with the
   * stored form of the answer.
   */
  async *ask(principal: Principal, content: string): AsyncGenerator<ChatStreamEvent> {
    // Prior turns (before this one) feed the conversational rewriter (F3).
    const history = await this.recentTurns(principal);
    await this.db.insert(chatMessage).values({ ownerId: principal.userId, role: 'user', content });

    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
      history,
    });
    const facts = retrieved.memories.map((hit, i) => toFactDto(hit, i));
    yield { type: 'sources', facts };

    let answer: string;
    if (facts.length === 0) {
      // The zero-retrieval path: no model call, no generation from thin air.
      answer = NOTHING_ON_RECORD;
      yield { type: 'token', text: answer };
    } else {
      const prompt = await this.getPrompt();
      let buffer = '';
      const stream = this.gateway.completeStream({
        system: prompt.content,
        input: buildAnswerInput(facts, content, retrieved.mode),
        tier: 'answer',
      });
      for await (const text of stream) {
        buffer += text;
        yield { type: 'token', text };
      }
      answer = buffer;
    }

    const { text: stored, violations } = toStoredAnswer(answer, facts);
    if (violations > 0) {
      // Metadata only — never the answer content or tokens (pino rule).
      this.logger.warn(`citation_violation stripped=${violations}`);
    }
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, role: 'assistant', content: stored })
      .returning();
    yield { type: 'done', messageId: row!.id, content: stored, citationViolations: violations };
  }

  /** The last few turns, oldest first — context for the rewriter (F3). */
  private async recentTurns(principal: Principal): Promise<ConversationTurn[]> {
    const rows = await this.db
      .select({ role: chatMessage.role, content: chatMessage.content })
      .from(chatMessage)
      .where(eq(chatMessage.ownerId, principal.userId))
      .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
      .limit(REWRITE_HISTORY_TURNS);
    return rows.reverse();
  }

  private async getPrompt(): Promise<PromptArtifact> {
    this.prompt ??= await loadPrompt(ANSWER_PROMPT.family, ANSWER_PROMPT.version);
    return this.prompt;
  }
}

function toFactDto(hit: RetrievedMemory, index: number): ChatFactDto {
  return {
    marker: `F${index + 1}`,
    memoryId: hit.memory.id,
    claim: hit.memory.content,
    status: hit.memory.status,
    sensitive: hit.memory.sensitive,
    subjectEntity: hit.memory.subjectEntity,
    sourceType: hit.memory.sourceType,
    sourceId: hit.memory.sourceId,
    validFrom: hit.memory.validFrom?.toISOString() ?? null,
    validUntil: hit.memory.validUntil?.toISOString() ?? null,
    signals: hit.signals,
  };
}

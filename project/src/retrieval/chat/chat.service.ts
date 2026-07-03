import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { ChatFactDto, ChatMessageDto, ChatStreamEvent, Principal } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db } from '../../infrastructure/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { RetrievalService } from '../retrieval.service';
import type { RetrievedMemory } from '../retrieval.service';
import { chatMessage } from '../persistence/tables';
import {
  ANSWER_PROMPT,
  buildAnswerInput,
  NOTHING_ON_RECORD,
  toStoredMarkers,
} from './answer-prompt';

/** How many facts the answer context receives. */
const ANSWER_FACTS_TOP_K = 8;
/** How much history the chat page loads. */
const HISTORY_LIMIT = 200;

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
    await this.db.insert(chatMessage).values({ ownerId: principal.userId, role: 'user', content });

    const retrieved = await this.retrieval.retrieve(principal, content, {
      topK: ANSWER_FACTS_TOP_K,
    });
    const facts = retrieved.map(toFactDto);
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
        input: buildAnswerInput(facts, content),
      });
      for await (const text of stream) {
        buffer += text;
        yield { type: 'token', text };
      }
      answer = buffer;
    }

    const stored = toStoredMarkers(answer, facts);
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId: principal.userId, role: 'assistant', content: stored })
      .returning();
    yield { type: 'done', messageId: row!.id, content: stored };
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
    sourceType: hit.memory.sourceType,
    sourceId: hit.memory.sourceId,
    validFrom: hit.memory.validFrom?.toISOString() ?? null,
    validUntil: hit.memory.validUntil?.toISOString() ?? null,
    signals: hit.signals,
  };
}

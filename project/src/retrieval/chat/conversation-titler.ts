import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, Tx } from '../../infrastructure/index';
import { loadPrompt, ModelGateway } from '../../model-gateway/index';
import type { PromptArtifact } from '../../model-gateway/index';
import { chatMessage, conversation } from '../persistence/tables';

/** The auto-title worker job. Idempotency key
 * ('chat_conversation', <conversation id>, this) — one attempt chain per
 * conversation; a later manual state change is always respected. */
export const CONVERSATION_TITLE_JOB_TYPE = 'conversation.title';

export const CONVERSATION_TITLE_PROMPT = {
  family: 'conversation_title',
  version: 'v0001',
} as const;

/** Opening turns the titler reads — the first exchange plus a little slack. */
const TITLE_TURNS = 4;
/** Hard cap on the stored title; the prompt asks for far less. */
const TITLE_MAX_CHARS = 60;

const titleSchema = z.object({ title: z.string() });

/**
 * Names an untitled conversation from its opening messages: one
 * pipeline-tier call, conservative and plain. Runs in the worker (spec §15.4 — the
 * model call never sits in the request path). The user's manual rename always
 * wins: the guarded UPDATE re-checks `title IS NULL AND NOT title_set_by_user`
 * at write time, so a rename that lands mid-call is never overwritten.
 */
@Injectable()
export class ConversationTitler {
  private prompt?: PromptArtifact;
  private readonly logger = new Logger(ConversationTitler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: ModelGateway,
  ) {}

  async run(tx: Tx, conversationId: string): Promise<{ titled: boolean }> {
    const rows = await tx
      .select({ title: conversation.title, titleSetByUser: conversation.titleSetByUser })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    const row = rows[0];
    if (!row || row.title !== null || row.titleSetByUser) return { titled: false };

    const turns = await tx
      .select({ role: chatMessage.role, content: chatMessage.content })
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, conversationId))
      .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id))
      .limit(TITLE_TURNS);
    if (turns.length === 0) return { titled: false };

    const input = turns
      .map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.content.slice(0, 500)}`)
      .join('\n');
    let title: string;
    try {
      this.prompt ??= await loadPrompt(
        CONVERSATION_TITLE_PROMPT.family,
        CONVERSATION_TITLE_PROMPT.version,
      );
      const result = await this.gateway.extractStructured(titleSchema, {
        system: this.prompt.content,
        input,
        tier: 'pipeline',
      });
      title = sanitizeTitle(result.title);
    } catch (error) {
      // Metadata only (pino rule). Rethrow so graphile retries with backoff;
      // exhaustion parks in dead_letter and the thread stays "New conversation".
      this.logger.warn(
        `conversation_title_failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      throw error;
    }
    if (!title) return { titled: false };

    // Guarded write: a manual rename (or a concurrent auto-title) wins.
    const updated = await tx
      .update(conversation)
      .set({ title })
      .where(
        and(
          eq(conversation.id, conversationId),
          eq(conversation.titleSetByUser, false),
          isNull(conversation.title),
        ),
      )
      .returning({ id: conversation.id });
    return { titled: updated.length > 0 };
  }
}

/** Plain, short, no wrapping quotes, never a typographic dash (house rule). */
export function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”]+|["'“”.]+$/g, '')
    .replace(/[–—]/g, ',')
    .replace(/\s+/g, ' ')
    .slice(0, TITLE_MAX_CHARS)
    .trim();
}

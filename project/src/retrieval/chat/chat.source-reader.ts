import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db } from '../../infrastructure/index';
import type { SourceItem, SourceReader } from '../../ingestion/index';
import { chatMessage } from '../persistence/tables';

/**
 * Ingestion's stage-1 port for source_type 'chat' (decision 0021): the pipeline
 * reads a remembered chat message through this, never the chat_message table
 * directly (§A.1 rule 2). Loads ONLY `user` messages — the assistant's own
 * output is never evidence about the world (ruling 4), so an assistant id can
 * never yield a source item even if one were enqueued. Scope is omitted → the
 * embed-store stage defaults the derived memories to private (ruling 6).
 */
@Injectable()
export class ChatSourceReader implements SourceReader {
  readonly sourceType = 'chat' as const;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db
      .select()
      .from(chatMessage)
      .where(and(eq(chatMessage.id, sourceId), eq(chatMessage.role, 'user')))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      content: row.content,
      createdAt: row.createdAt,
    };
  }
}

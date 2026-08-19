import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { UserSettingsService } from '../settings/index';
import { chatMessage, conversation } from './persistence/tables';

/**
 * Ingestion's stage-1 port for source_type 'chat': the pipeline
 * reads a remembered chat message through this, never the chat_message table
 * directly (spec §15 rule 2). Loads ONLY `user` messages — the assistant's own
 * output is never evidence about the world (ruling 4), so an assistant id can
 * never yield a source item even if one were enqueued.
 *
 * Scope is STAMPED (V2.0 item 3.7). It used to be omitted, so the embed-store
 * stage's `?? 'private'` decided it: a user whose default capture scope is
 * `shared` got shared memories from notes, files, email and web, and private
 * ones from chat, with nothing in the product saying so. Every other connector
 * reads the scope off a row written at capture time from the same setting; chat
 * has no such column, so the reader resolves it the way the email intake does,
 * from the owner's default at read time.
 */
@Injectable()
export class ChatSourceReader implements SourceReader {
  readonly sourceType = 'chat' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: UserSettingsService,
  ) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db
      .select({ message: chatMessage, spaceId: conversation.spaceId })
      .from(chatMessage)
      .innerJoin(conversation, eq(conversation.id, chatMessage.conversationId))
      .where(and(eq(chatMessage.id, sourceId), eq(chatMessage.role, 'user')))
      .limit(1);
    const row = rows[0]?.message;
    if (!row) return null;
    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      // A message inherits its CONVERSATION's space (docs/features/spaces.md):
      // the container carries the dimension, the derived facts inherit it.
      spaceId: rows[0]!.spaceId,
      // The owner's default capture scope, explicitly — never the pipeline's
      // fallback (V2.0 item 3.7).
      scope: await this.settings.defaultScopeFor(row.ownerId),
      // "Remember this" extracts the message itself — the one capture path
      // (the create_task normalization went with).
      content: row.content,
      // Only USER messages are ever loaded here (the WHERE above, and the
      // capture endpoint), so captured chat is always the user's own words.
      authoredByUser: true,
      createdAt: row.createdAt,
    };
  }

  /**
   * Admission checkpoint: KEY SHARE serializes against the
   * deletion saga's FOR UPDATE + DELETE on this chat row — see SourceReader.
   */
  async existsForAdmission(tx: Tx, sourceId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(and(eq(chatMessage.id, sourceId), eq(chatMessage.role, 'user')))
      .for('key share');
    return rows.length > 0;
  }
}

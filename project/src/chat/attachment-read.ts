import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, withTransactionalEnqueue } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { FILE_DISCARD_CLEANUP_JOB_TYPE } from '../ingestion/index';
import { LadderedDocumentReader, PermanentExtractionError } from '../files/index';
import { MemoryObjectStore } from '../memory/index';
import { chatAttachment } from './persistence/tables';

/**
 * The transient attachment read job (V2.2 item 5.1): one worker job per
 * "don't remember this file" attachment. Idempotency key
 * ('chat', <attachment id>, this); enqueued transactionally with the row.
 */
export const CHAT_ATTACHMENT_READ_JOB_TYPE = 'chat.attachment_read';

/**
 * Reads a transient attachment's staged bytes ONCE, through the same laddered
 * reader a durable upload gets (text layer, OCR, probed vision, same caps and
 * spend metering), stores the text on the chat-owned row, and schedules the
 * staged bytes' deletion in the SAME transaction, so the bytes go exactly
 * when the text that replaces them is durable. The delayed backstop enqueued
 * at attach time deletes them even if this job never succeeds.
 *
 * An unreadable file is an HONEST OUTCOME, not a job failure: the row records
 * the reading layer's own outcome and reason (unreadable scan, needs vision,
 * unsupported format) and the job completes, because retrying a permanent
 * parse error three times buys nothing and the card needs the reason, not a
 * dead letter. Only transient infrastructure errors rethrow into retry.
 */
@Injectable()
export class ChatAttachmentReadService {
  private readonly logger = new Logger(ChatAttachmentReadService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly objects: MemoryObjectStore,
    private readonly reader: LadderedDocumentReader,
  ) {}

  async run(tx: Tx, attachmentId: string): Promise<{ read: boolean }> {
    const rows = await tx
      .select()
      .from(chatAttachment)
      .where(eq(chatAttachment.id, attachmentId))
      .limit(1);
    const row = rows[0];
    // Vanished, already handled, or not a transient row: complete cleanly.
    if (!row || !row.transient || row.status !== 'pending' || !row.stagingKey) {
      return { read: false };
    }

    const stagingKey = row.stagingKey;
    const stat = await this.objects.statObject(stagingKey);
    if (!stat) {
      // The backstop (or a manual cleanup) beat us to the bytes. The honest
      // record: nothing was read, and nothing is retained.
      await tx
        .update(chatAttachment)
        .set({
          status: 'failed',
          readOutcome: 'read_failed',
          readReason: 'staging_missing',
          stagingKey: null,
        })
        .where(eq(chatAttachment.id, attachmentId));
      return { read: false };
    }

    const object = await this.objects.getObject(stagingKey);
    const filename = decode(object.metadata['original-filename']);
    try {
      const { text, report } = await this.reader.read(
        row.ownerId,
        object.body,
        object.contentType,
        filename,
      );
      await tx
        .update(chatAttachment)
        .set({
          status: 'ready',
          contentText: text,
          readOutcome: report.outcome,
          readReason: report.reasonCode ?? null,
          stagingKey: null,
        })
        .where(eq(chatAttachment.id, attachmentId));
    } catch (error) {
      if (!(error instanceof PermanentExtractionError)) throw error;
      await tx
        .update(chatAttachment)
        .set({
          status: 'failed',
          readOutcome: error.outcome,
          readReason: error.reasonCode,
          stagingKey: null,
        })
        .where(eq(chatAttachment.id, attachmentId));
    }

    // Commit-then-delete (the discard-mode rule): the staging delete fires
    // only when this transaction — the text or the honest failure — commits.
    await withTransactionalEnqueue(
      tx,
      {
        type: 'chat.attachment_staging_discarded',
        payload: { source_type: 'chat', source_id: attachmentId, owner_id: row.ownerId },
      },
      {
        type: FILE_DISCARD_CLEANUP_JOB_TYPE,
        payload: { source_type: 'file', source_id: stagingKey },
      },
    );
    return { read: true };
  }
}

function decode(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The worker-side module for the read job: needs memory's object store and
 * files' laddered reader, so it CANNOT live in ChatSourceModule (whose charter
 * is DRIZZLE-only providers importable by memory without a cycle). The worker
 * root threads the two family instances in.
 */
@Module({})
export class ChatAttachmentWorkerModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ChatAttachmentWorkerModule,
      imports: [...(options.imports ?? [])],
      providers: [ChatAttachmentReadService],
      exports: [ChatAttachmentReadService],
    };
  }
}

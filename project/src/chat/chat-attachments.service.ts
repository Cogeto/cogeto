import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { ChatAttachmentDto, FileProcessingState, Principal } from '@cogeto/shared';
import {
  DRIZZLE,
  enqueueDelayedJob,
  jobRunState,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  INGESTION_PIPELINE_JOB_TYPE,
  latestGateRefusalFor,
  pipelineStageFor,
} from '../ingestion/index';
import { FilesService } from '../files/index';
import type { UploadedFile } from '../files/index';
import { MemoryReconciliation, MemoryStore } from '../memory/index';
import { UserSettingsService } from '../settings/index';
import { chatAttachment, conversation } from './persistence/tables';
import type { ChatAttachmentRow } from './persistence/tables';
import { CHAT_ATTACHMENT_READ_JOB_TYPE } from './attachment-read';

/** The staging backstop delay, mirroring discard mode's. */
const STAGING_BACKSTOP_MINUTES = 15;

/**
 * Files attached in chat (V2.2 item 5.1). Two modes, one honest card each:
 *
 * - **Durable (the default)**: delegates to `FilesService.upload`, so the
 *   attachment IS an ordinary file source — same validation, caps, quota,
 *   pipeline, gate, provenance — and this service only records the LINK into
 *   the conversation, then answers the card's polls: the queue's terminal
 *   state, the pipeline's honest stage, and, once settled, the real numbers
 *   (facts, open contradictions, read outcome, gate refusal), stamped onto
 *   the row so history stops re-querying.
 *
 * - **Transient ("don't remember this file")**: `FilesService.stageTransient`
 *   applies the same validation and staging discipline, then ONE chat-owned
 *   worker job reads the bytes through the same ladder and stores the text on
 *   the row for this conversation's answer path. Never a source, never
 *   extracted, never in memory, invisible to every other conversation; the
 *   conversation deletion saga erases the text under its receipt.
 */
@Injectable()
export class ChatAttachmentsService {
  private readonly logger = new Logger(ChatAttachmentsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly files: FilesService,
    private readonly memory: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
    private readonly settings: UserSettingsService,
  ) {}

  /** Attach one file to a conversation. The conversation must be the caller's. */
  async attach(
    principal: Principal,
    conversationId: string,
    file: UploadedFile,
    options: { transient: boolean },
  ): Promise<ChatAttachmentDto> {
    await this.requireConversation(principal, conversationId);
    return options.transient
      ? this.attachTransient(principal, conversationId, file)
      : this.attachDurable(principal, conversationId, file);
  }

  private async attachDurable(
    principal: Principal,
    conversationId: string,
    file: UploadedFile,
  ): Promise<ChatAttachmentDto> {
    // The ONE upload path (issue A rule: one path, two affordances): the same
    // call the Sources upload makes, under the owner's stored defaults —
    // private scope unless they changed it, and their discard-by-default
    // preference honoured exactly as a deliberate upload honours it.
    const defaults = await this.settings.get(principal);
    const { objectKey } = await this.files.upload(
      principal,
      file,
      {
        scope: defaults.defaultScope,
        sensitive: false,
        discard: defaults.discardByDefault,
      },
      // Sending a file the conversation partner already has attaches THAT
      // document (issue #536). The row is still written, because the file
      // genuinely was sent in this conversation, and its card settles
      // immediately with the existing source's real numbers instead of
      // replaying an extraction that was already paid for.
      { deduplicate: true },
    );
    const [row] = await this.db
      .insert(chatAttachment)
      .values({
        ownerId: principal.userId,
        conversationId,
        transient: false,
        objectKey,
        displayName: file.originalName,
        contentType: file.mimeType.split(';')[0]!.trim().toLowerCase(),
        sizeBytes: file.buffer.length,
      })
      .returning();
    return this.toDto(row!, 'processing', null);
  }

  private async attachTransient(
    principal: Principal,
    conversationId: string,
    file: UploadedFile,
  ): Promise<ChatAttachmentDto> {
    const staged = await this.files.stageTransient(principal, file);
    let row: ChatAttachmentRow | undefined;
    try {
      // Row + read job + delayed staging backstop in ONE transaction, the
      // discard-mode shape: the backstop deletes the staged bytes even if the
      // read never succeeds, so "never durably retained" does not depend on a
      // happy path.
      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(chatAttachment)
          .values({
            ownerId: principal.userId,
            conversationId,
            transient: true,
            stagingKey: staged.stagingKey,
            displayName: file.originalName,
            contentType: staged.contentType,
            sizeBytes: staged.sizeBytes,
          })
          .returning();
        row = inserted[0]!;
        await withTransactionalEnqueue(
          tx,
          {
            type: 'chat.attachment_staged',
            payload: { source_type: 'chat', source_id: row.id, owner_id: principal.userId },
          },
          {
            type: CHAT_ATTACHMENT_READ_JOB_TYPE,
            payload: { source_type: 'chat', source_id: row.id },
            maxAttempts: 3,
          },
        );
        await enqueueDelayedJob(
          tx,
          {
            type: FILE_DISCARD_CLEANUP_JOB_TYPE,
            payload: { source_type: 'file', source_id: staged.stagingKey },
            maxAttempts: 5,
          },
          STAGING_BACKSTOP_MINUTES,
        );
      });
    } catch (error) {
      // Abort window: no job was enqueued, so the staged bytes are a true
      // orphan — remove them now rather than waiting on nothing.
      await this.files.deleteStagedTransient(staged.stagingKey).catch(() => undefined);
      throw error;
    }
    return this.toDto(row!, 'processing', null);
  }

  /**
   * Links attachments to the user message they were sent with — called by the
   * ask path right after the message row is inserted. Owner- and
   * conversation-gated; already-linked rows are left alone, so a retried send
   * cannot steal an attachment from its message.
   */
  async linkToMessage(
    principal: Principal,
    conversationId: string,
    messageId: string,
    attachmentIds: string[],
  ): Promise<void> {
    if (attachmentIds.length === 0) return;
    await this.db
      .update(chatAttachment)
      .set({ messageId })
      .where(
        and(
          inArray(chatAttachment.id, attachmentIds),
          eq(chatAttachment.ownerId, principal.userId),
          eq(chatAttachment.conversationId, conversationId),
          isNull(chatAttachment.messageId),
        ),
      );
  }

  /** The conversation's attachments, oldest first — the timeline's cards. */
  async listForConversation(
    principal: Principal,
    conversationId: string,
  ): Promise<ChatAttachmentDto[]> {
    await this.requireConversation(principal, conversationId);
    const rows = await this.db
      .select()
      .from(chatAttachment)
      .where(eq(chatAttachment.conversationId, conversationId))
      .orderBy(asc(chatAttachment.createdAt), asc(chatAttachment.id));
    return Promise.all(rows.map((row) => this.resolve(row)));
  }

  /** One attachment's current state — the card's poll. */
  async get(principal: Principal, attachmentId: string): Promise<ChatAttachmentDto> {
    const rows = await this.db
      .select()
      .from(chatAttachment)
      .where(and(eq(chatAttachment.id, attachmentId), eq(chatAttachment.ownerId, principal.userId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`attachment ${attachmentId} not found`);
    return this.resolve(row);
  }

  /**
   * The conversation's READY transient texts, newest first, for the answer
   * path. Bounded by the caller; the row's text was already capped at read
   * time by the parse caps.
   */
  async transientTextsFor(
    ownerId: string,
    conversationId: string,
  ): Promise<{ name: string; text: string }[]> {
    const rows = await this.db
      .select({
        name: chatAttachment.displayName,
        text: chatAttachment.contentText,
        createdAt: chatAttachment.createdAt,
        id: chatAttachment.id,
      })
      .from(chatAttachment)
      .where(
        and(
          eq(chatAttachment.conversationId, conversationId),
          eq(chatAttachment.ownerId, ownerId),
          eq(chatAttachment.transient, true),
          eq(chatAttachment.status, 'ready'),
        ),
      )
      .orderBy(asc(chatAttachment.createdAt), asc(chatAttachment.id));
    return rows
      .filter((row) => (row.text ?? '').trim().length > 0)
      .map((row) => ({ name: row.name ?? 'attached file', text: row.text! }));
  }

  /**
   * Resolves a row into the card's DTO. Durable rows derive their live state
   * from the queue's ledgers plus the pipeline's stage row; the first read
   * after the pipeline settles stamps the outcome (facts, contradictions,
   * read outcome, gate refusal) so a conversation's history stays cheap and
   * stops changing.
   */
  private async resolve(row: ChatAttachmentRow): Promise<ChatAttachmentDto> {
    if (row.transient) {
      if (row.status === 'ready') return this.toDto(row, 'done', null);
      if (row.status === 'failed') return this.toDto(row, 'error', null);
      const state = await jobRunState(this.db, {
        sourceType: 'chat',
        sourceId: row.id,
        jobType: CHAT_ATTACHMENT_READ_JOB_TYPE,
      });
      // A committed job with the row still pending means the handler recorded
      // a failure shape it could not write (crash window): honest = error.
      return this.toDto(row, state === 'processing' ? 'processing' : 'error', null);
    }

    if (row.status === 'source_deleted') return this.toDto(row, 'done', null);
    if (row.status === 'settled') return this.toDto(row, 'done', null);

    const state = await jobRunState(this.db, {
      sourceType: 'file',
      sourceId: row.objectKey!,
      jobType: INGESTION_PIPELINE_JOB_TYPE,
    });
    if (state === 'processing') {
      const stage = await pipelineStageFor(this.db, {
        sourceType: 'file',
        sourceId: row.objectKey!,
      });
      return this.toDto(row, 'processing', stage);
    }
    if (state === 'failed') {
      const stamped = await this.stampSettled(row, 'failed');
      return this.toDto(stamped, 'error', null);
    }
    const stamped = await this.stampSettled(row, 'settled');
    return this.toDto(stamped, 'done', null);
  }

  /** Stamps a durable row's outcome once, on the first read after settle. */
  private async stampSettled(
    row: ChatAttachmentRow,
    status: 'settled' | 'failed',
  ): Promise<ChatAttachmentRow> {
    const principal: Principal = principalOf(row);
    const objectKey = row.objectKey!;
    const [facts, contradictions, read, refusal] = await Promise.all([
      this.memory.countBySourceForPrincipal(principal, 'file', objectKey),
      this.reconciliation.countOpenContradictionsForSource(principal, 'file', objectKey),
      this.files.getReadReport(objectKey),
      latestGateRefusalFor(this.db, { sourceType: 'file', sourceId: objectKey }),
    ]);
    const [updated] = await this.db
      .update(chatAttachment)
      .set({
        status,
        factsCount: facts,
        contradictionsCount: contradictions,
        readOutcome: read?.outcome ?? null,
        readReason: read?.reasonCode ?? null,
        gateRefusal: refusal?.reason ?? null,
        settledAt: new Date(),
      })
      .where(and(eq(chatAttachment.id, row.id), isNull(chatAttachment.settledAt)))
      .returning();
    if (!updated) {
      // Another poll stamped it first — read the stamped row back.
      const rows = await this.db
        .select()
        .from(chatAttachment)
        .where(eq(chatAttachment.id, row.id))
        .limit(1);
      return rows[0] ?? row;
    }
    return updated;
  }

  private toDto(
    row: ChatAttachmentRow,
    state: FileProcessingState,
    stage: ChatAttachmentDto['stage'],
  ): ChatAttachmentDto {
    // A durable row that dead-lettered reads as error even though its stamp
    // says 'failed'; a transient failure is 'error' too — the DTO speaks the
    // file-surface vocabulary either way.
    const effectiveState: FileProcessingState = row.status === 'failed' ? 'error' : state;
    return {
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      transient: row.transient,
      name: row.displayName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      state: effectiveState,
      stage,
      objectKey: row.status === 'source_deleted' ? null : row.objectKey,
      readOutcome: (row.readOutcome as ChatAttachmentDto['readOutcome']) ?? null,
      readReason: row.readReason,
      factsCount: row.factsCount,
      contradictionsCount: row.contradictionsCount,
      gateRefusal: row.gateRefusal,
      sourceDeleted: row.status === 'source_deleted',
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async requireConversation(principal: Principal, conversationId: string): Promise<void> {
    const rows = await this.db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.ownerId, principal.userId)))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(`conversation ${conversationId} not found`);
    }
  }
}

/**
 * The row's owner as a Principal for the gated counting reads. The org id is
 * recoverable from the durable object key, whose first segment is the org
 * (the object-key contract); the gated reads only use userId + orgId.
 */
function principalOf(row: ChatAttachmentRow): Principal {
  return {
    userId: row.ownerId,
    name: '',
    email: null,
    orgId: row.objectKey?.split('/')[0] ?? '',
    orgName: '',
    roles: [],
  };
}

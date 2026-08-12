import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type {
  ChatAttachmentCreatedDto,
  CitingAnswerDto,
  ChatAttachmentDto,
  ChatContextDto,
  ChatMessagePage,
  ChatRememberedDto,
  ChatStreamEvent,
  ConversationDto,
  ConversationSearchHitDto,
  NoteStatusDto,
} from '@cogeto/shared';
import {
  DRIZZLE,
  RateLimit,
  RateLimitGuard,
  SSE_LIMITS,
  parseOrBadRequest,
} from '../infrastructure/index';
import type { Db, SseLimits } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ModelBudgetExceededError } from '../model-gateway/index';
import { DocumentUploadInterceptor } from '../files/index';
import { ChatAttachmentsService } from './chat-attachments.service';
import { answersCiting } from './source-listing';
import { ChatService } from './chat.service';

/** How many attachments one message can carry. */
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** Zod at the boundary — same bounds as note capture. */
const askSchema = z.object({
  content: z
    .string()
    .max(4_000, 'message is too long (max 4000 characters)')
    .refine((value) => value.trim().length > 0, 'message must not be blank'),
  /** The conversation the message is sent to — it always lands there. */
  conversationId: z.uuid(),
  /** Thinking mode for this turn (issue #424): false answers directly on a
   * controllable reasoning endpoint; absent or true deliberates as before. */
  thinking: z.boolean().optional(),
  /** Attachments sent with this message (V2.2 item 5.1) — already created via
   * POST /api/chat/attachments; the send links them to the message row. */
  attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  /** Widen THIS question past the project retrieval lens (V2.5 item 8.3):
   * per-turn, never persisted, and the same control the lens-gap reply
   * offers, so there is one widening path rather than two. */
  widen: z.boolean().optional(),
});

/** Multipart text fields arrive as strings; accept the common truthy forms. */
const boolField = z
  .union([z.boolean(), z.enum(['true', 'false', 'on', 'off', '1', '0'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === 'on' || value === '1',
  );

/** The paperclip's flags: which conversation, and whether to remember. */
const attachSchema = z.object({
  conversationId: z.uuid(),
  /** "Don't remember this file": conversation-only, never a source. */
  transient: boolField.optional(),
});

/** Rename bounds: one plain line, never blank. */
const renameSchema = z.object({
  title: z
    .string()
    .max(120, 'title is too long (max 120 characters)')
    .refine((value) => value.trim().length > 0, 'title must not be blank'),
});

const archiveSchema = z.object({ archived: z.boolean() });

/** Search bounds: a query long enough to mean something, short enough to be a
 * search rather than a paste. */
const searchSchema = z.object({ q: z.string().min(1).max(200) });

/** A new conversation may start inside a project (V2.5 item 8.3), optionally. */
const createConversationSchema = z.object({ projectId: z.uuid().nullable().optional() });

/** House pagination (limit/offset) for messages-by-conversation. */
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).prefault(200),
  offset: z.coerce.number().int().min(0).prefault(0),
});

@Controller('chat')
@UseGuards(BearerAuthGuard)
export class ChatController {
  /** Active SSE streams per principal — the concurrency cap's counter. */
  private readonly activeStreams = new Map<string, number>();

  constructor(
    private readonly chat: ChatService,
    private readonly attachments: ChatAttachmentsService,
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(SSE_LIMITS) private readonly sse: SseLimits,
  ) {}

  /**
   * The paperclip (V2.2 item 5.1): attach one file to a conversation. The
   * same multipart interceptor, byte cap, rate bucket and daily quota as
   * POST /api/files — one path, two affordances. Default is ingestion through
   * the normal pipeline; `transient=true` keeps the file conversation-only.
   */
  @Post('attachments')
  @UseGuards(RateLimitGuard)
  @RateLimit('upload')
  @UseInterceptors(DocumentUploadInterceptor)
  async attach(@Req() request: AuthenticatedRequest): Promise<ChatAttachmentCreatedDto> {
    const file = request.file;
    if (!file) throw new BadRequestException('no file provided (field name must be "file")');
    const parsed = parseOrBadRequest(attachSchema, request.body ?? {});
    const attachment = await this.attachments.attach(
      request.principal,
      parsed.conversationId,
      { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype },
      { transient: parsed.transient ?? false },
    );
    return { attachment };
  }

  /** One attachment's current state — the card's poll. */
  @Get('attachments/:id')
  async attachment(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChatAttachmentDto> {
    return this.attachments.get(request.principal, id);
  }

  /** A conversation's attachments, oldest first — the timeline's cards. */
  @Get('conversations/:id/attachments')
  async conversationAttachments(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChatAttachmentDto[]> {
    return this.attachments.listForConversation(request.principal, id);
  }

  /**
   * Find a conversation by what was said in it (issue #530). Owner-scoped,
   * bounded, and archived threads included: an archived one is exactly what
   * scrolling cannot find.
   */
  @Get('search')
  async search(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<ConversationSearchHitDto[]> {
    const parsed = parseOrBadRequest(searchSchema, query ?? {});
    return this.chat.searchConversations(request.principal, parsed.q);
  }

  /** The sidebar's conversation list: newest activity first. */
  @Get('conversations')
  async conversations(@Req() request: AuthenticatedRequest): Promise<ConversationDto[]> {
    return this.chat.listConversations(request.principal);
  }

  /** A new, untitled conversation, optionally inside a project. */
  @Post('conversations')
  async createConversation(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ConversationDto> {
    const parsed = parseOrBadRequest(createConversationSchema, body ?? {});
    return this.chat.createConversation(request.principal, parsed.projectId ?? null);
  }

  /** Manual rename — wins forever over the auto-titler. */
  @Put('conversations/:id/title')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConversationDto> {
    const parsed = parseOrBadRequest(renameSchema, body);
    return this.chat.renameConversation(request.principal, id, parsed.title.trim());
  }

  /** Archive / unarchive — the safe alternative to deletion. */
  @Put('conversations/:id/archived')
  async setArchived(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConversationDto> {
    const parsed = parseOrBadRequest(archiveSchema, body);
    return this.chat.setConversationArchived(request.principal, id, parsed.archived);
  }

  /** One conversation's messages: offset 0 = the latest window, items oldest
   * first within the page. Deleting a conversation is a SOURCE deletion —
   * DELETE /api/sources/chat_conversation/:id — never a chat route (spec §11.1). */
  @Get('conversations/:id/messages')
  async messages(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<ChatMessagePage> {
    const parsed = parseOrBadRequest(pageSchema, query ?? {});
    return this.chat.listMessages(request.principal, id, parsed);
  }

  /** "Remember this": capture a USER message via the pipeline. */
  @Post('messages/:id/remember')
  @UseGuards(RateLimitGuard)
  @RateLimit('remember')
  async remember(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChatRememberedDto> {
    return this.chat.rememberMessage(request.principal, id);
  }

  /** Capture progress for the "remembering…" indicator. */
  @Get('messages/:id/capture-status')
  async captureStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NoteStatusDto> {
    return { state: await this.chat.captureState(request.principal, id) };
  }

  /**
   * The answers that cited one memory (V2.2 item 5.2, the fact detail view).
   * The linkage is the stored content itself: persisted answers carry
   * canonical `{{cite:<memoryId>}}` tokens and redaction erases them with the
   * cited memory, so the scan is honest history, never a fabricated one.
   */
  @Get('citing/:memoryId')
  async citing(
    @Req() request: AuthenticatedRequest,
    @Param('memoryId', ParseUUIDPipe) memoryId: string,
  ): Promise<CitingAnswerDto[]> {
    const rows = await answersCiting(this.db, request.principal.userId, memoryId);
    return rows.map((row) => ({
      messageId: row.messageId,
      conversationId: row.conversationId,
      conversationTitle: row.conversationTitle,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** The chat context behind a remembered memory's source drawer. */
  @Get('messages/:id/context')
  async context(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChatContextDto> {
    return this.chat.messageContext(request.principal, id);
  }

  /**
   * Ask a question — SSE stream (sources → token* → done). Fast path only
   * retrieval + generation, nothing enqueued (spec §15.4).
   *
   * Bounded: a per-principal concurrent-stream cap (429 before the
   * stream starts) plus an idle timeout and a hard max-duration abort, so a
   * caller cannot pin unbounded Node handlers + upstream model streams. The
   * per-principal request rate and the daily model budget bound it further.
   */
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit('chat')
  async ask(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const parsed = parseOrBadRequest(askSchema, body);

    // The conversation gate: resolve BEFORE any header is sent, so a
    // foreign or absent conversation is a normal 404, not a truncated stream.
    await this.chat.assertConversation(request.principal, parsed.conversationId);

    // Concurrency cap: reject BEFORE any header is sent, so the client
    // sees a normal 429 rather than a truncated stream.
    const userId = request.principal.userId;
    const active = this.activeStreams.get(userId) ?? 0;
    if (this.sse.maxConcurrentPerPrincipal > 0 && active >= this.sse.maxConcurrentPerPrincipal) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'too_many_streams',
          message: `too many concurrent chat streams (max ${this.sse.maxConcurrentPerPrincipal})`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.activeStreams.set(userId, active + 1);

    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('cache-control', 'no-cache');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders();

    const write = (event: ChatStreamEvent) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Idle + max-duration abort. The idle timer resets on every token;
    // the duration timer is a hard ceiling. An abort races the generator so it
    // fires even while the upstream model call is still awaiting.
    const controller = new AbortController();
    const idleMs = this.sse.idleTimeoutSeconds * 1000;
    const maxMs = this.sse.maxDurationSeconds * 1000;
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('idle')), idleMs);
    };
    const maxTimer =
      maxMs > 0 ? setTimeout(() => controller.abort(new Error('duration')), maxMs) : undefined;
    resetIdle();

    const stream = this.chat.ask(request.principal, parsed.content, parsed.conversationId, {
      thinking: parsed.thinking,
      attachmentIds: parsed.attachmentIds,
      widen: parsed.widen,
    });
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const abortPromise = new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new Error('aborted'));
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        const nextPromise = iterator.next();
        let step: IteratorResult<ChatStreamEvent>;
        try {
          step = await Promise.race([nextPromise, abortPromise]);
        } catch {
          // Timed out: abandon the in-flight step (swallow its late settle) and
          // tell the caller. Ask the generator to stop, but do NOT await it — a
          // generator suspended on a never-settling upstream await would hang.
          nextPromise.catch(() => undefined);
          write({ type: 'error', message: 'response timed out', code: 'timeout' });
          void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
          break;
        }
        if (step.done) break;
        write(step.value);
        resetIdle();
      }
    } catch (error) {
      // Never a stack trace or memory content down the wire (pino rule applies
      // to streams too). A spent daily budget gets a specific code.
      if (error instanceof ModelBudgetExceededError) {
        write({ type: 'error', message: error.message, code: 'model_budget_exceeded' });
      } else {
        write({ type: 'error', message: 'answer generation failed, try again' });
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
      const remaining = (this.activeStreams.get(userId) ?? 1) - 1;
      if (remaining <= 0) this.activeStreams.delete(userId);
      else this.activeStreams.set(userId, remaining);
      response.end();
    }
  }
}

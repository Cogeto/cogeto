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
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type {
  ChatContextDto,
  ChatMessagePage,
  ChatRememberedDto,
  ChatStreamEvent,
  ConversationDto,
  NoteStatusDto,
} from '@cogeto/shared';
import { RateLimit, RateLimitGuard, SSE_LIMITS } from '../../infrastructure/index';
import type { SseLimits } from '../../infrastructure/index';
import { BearerAuthGuard } from '../../identity/index';
import type { AuthenticatedRequest } from '../../identity/index';
import { ModelBudgetExceededError } from '../../model-gateway/index';
import { ChatService } from './chat.service';

/** Zod at the boundary — same bounds as note capture. */
const askSchema = z.object({
  content: z
    .string()
    .max(4_000, 'message is too long (max 4000 characters)')
    .refine((value) => value.trim().length > 0, 'message must not be blank'),
  /** The conversation the message is sent to — it always lands there. */
  conversationId: z.uuid(),
});

/** Rename bounds: one plain line, never blank. */
const renameSchema = z.object({
  title: z
    .string()
    .max(120, 'title is too long (max 120 characters)')
    .refine((value) => value.trim().length > 0, 'title must not be blank'),
});

const archiveSchema = z.object({ archived: z.boolean() });

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
    @Inject(SSE_LIMITS) private readonly sse: SseLimits,
  ) {}

  /** The sidebar's conversation list: newest activity first. */
  @Get('conversations')
  async conversations(@Req() request: AuthenticatedRequest): Promise<ConversationDto[]> {
    return this.chat.listConversations(request.principal);
  }

  /** A new, untitled conversation. */
  @Post('conversations')
  async createConversation(@Req() request: AuthenticatedRequest): Promise<ConversationDto> {
    return this.chat.createConversation(request.principal);
  }

  /** Manual rename — wins forever over the auto-titler. */
  @Put('conversations/:id/title')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConversationDto> {
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.chat.renameConversation(request.principal, id, parsed.data.title.trim());
  }

  /** Archive / unarchive — the safe alternative to deletion. */
  @Put('conversations/:id/archived')
  async setArchived(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConversationDto> {
    const parsed = archiveSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.chat.setConversationArchived(request.principal, id, parsed.data.archived);
  }

  /** One conversation's messages: offset 0 = the latest window, items oldest
   * first within the page. Deleting a conversation is a SOURCE deletion —
   * DELETE /api/sources/chat_conversation/:id — never a chat route (§A.7). */
  @Get('conversations/:id/messages')
  async messages(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<ChatMessagePage> {
    const parsed = pageSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.chat.listMessages(request.principal, id, parsed.data);
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
   * retrieval + generation, nothing enqueued (§A.3).
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
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    // The conversation gate: resolve BEFORE any header is sent, so a
    // foreign or absent conversation is a normal 404, not a truncated stream.
    await this.chat.assertConversation(request.principal, parsed.data.conversationId);

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

    const stream = this.chat.ask(
      request.principal,
      parsed.data.content,
      parsed.data.conversationId,
    );
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
        write({ type: 'error', message: 'answer generation failed — try again' });
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

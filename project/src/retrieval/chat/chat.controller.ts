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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type {
  ChatContextDto,
  ChatMessageDto,
  ChatRememberedDto,
  ChatStreamEvent,
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
});

@Controller('chat')
@UseGuards(BearerAuthGuard)
export class ChatController {
  /** Active SSE streams per principal — the concurrency cap's counter (QS-14). */
  private readonly activeStreams = new Map<string, number>();

  constructor(
    private readonly chat: ChatService,
    @Inject(SSE_LIMITS) private readonly sse: SseLimits,
  ) {}

  /** The persisted conversation, oldest first. */
  @Get('messages')
  async messages(@Req() request: AuthenticatedRequest): Promise<ChatMessageDto[]> {
    return this.chat.listMessages(request.principal);
  }

  /** "Remember this" (decision 0021): capture a USER message via the pipeline. */
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
   * Ask a question — SSE stream (sources → token* → done). Fast path only:
   * retrieval + generation, nothing enqueued (§A.3).
   *
   * Bounded (FIX-2 QS-14): a per-principal concurrent-stream cap (429 before the
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

    // Concurrency cap (QS-14): reject BEFORE any header is sent, so the client
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

    // Idle + max-duration abort (QS-14). The idle timer resets on every token;
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

    const iterator = this.chat.ask(request.principal, parsed.data.content)[Symbol.asyncIterator]();
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
      // to streams too). A spent daily budget gets a specific code (QS-2).
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

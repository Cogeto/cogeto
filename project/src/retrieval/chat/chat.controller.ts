import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { BearerAuthGuard } from '../../identity/index';
import type { AuthenticatedRequest } from '../../identity/index';
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
  constructor(private readonly chat: ChatService) {}

  /** The persisted conversation, oldest first. */
  @Get('messages')
  async messages(@Req() request: AuthenticatedRequest): Promise<ChatMessageDto[]> {
    return this.chat.listMessages(request.principal);
  }

  /** "Remember this" (decision 0021): capture a USER message via the pipeline. */
  @Post('messages/:id/remember')
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
   */
  @Post()
  async ask(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('cache-control', 'no-cache');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders();

    const write = (event: ChatStreamEvent) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try {
      for await (const event of this.chat.ask(request.principal, parsed.data.content)) {
        write(event);
      }
    } catch {
      // Never a stack trace or memory content down the wire (pino rule applies
      // to streams too) — the client shows a retryable failure.
      write({ type: 'error', message: 'answer generation failed — try again' });
    }
    response.end();
  }
}

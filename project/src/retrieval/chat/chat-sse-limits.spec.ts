import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { Principal } from '@cogeto/shared';
import type { ChatStreamEvent } from '@cogeto/shared';
import { ChatController } from './chat.controller';
import type { ChatService } from './chat.service';
import type { SseLimits } from '../../infrastructure/index';

/** FIX-2 QS-14: concurrent-stream cap + idle/max-duration abort on chat SSE. */

const principal: Principal = {
  userId: 'user-a',
  name: 'A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const req = () => ({ principal }) as never;

function fakeResponse(): Response & { events: ChatStreamEvent[]; ended: boolean } {
  const events: ChatStreamEvent[] = [];
  const res = {
    headersSent: false,
    events,
    ended: false,
    setHeader() {},
    flushHeaders() {
      this.headersSent = true;
    },
    write(frame: string) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as ChatStreamEvent);
    },
    end() {
      this.ended = true;
    },
  };
  return res as unknown as Response & { events: ChatStreamEvent[]; ended: boolean };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const limits = (over: Partial<SseLimits> = {}): SseLimits => ({
  maxConcurrentPerPrincipal: 1,
  idleTimeoutSeconds: 10,
  maxDurationSeconds: 10,
  ...over,
});

describe('chat SSE limits (QS-14)', () => {
  it('caps concurrent streams per principal (429 before the stream starts)', async () => {
    const gate = deferred();
    const chat = {
      async *ask() {
        await gate.promise; // stream #1 hangs open
        yield { type: 'token', text: 'x' } as ChatStreamEvent;
      },
    } as unknown as ChatService;
    const controller = new ChatController(chat, limits({ maxConcurrentPerPrincipal: 1 }));

    // Stream #1 opens and holds a slot (floating — it stays inside the loop).
    const first = controller.ask(req(), { content: 'q1' }, fakeResponse());
    // Stream #2 must be rejected with a 429 before any header is sent.
    await expect(controller.ask(req(), { content: 'q2' }, fakeResponse())).rejects.toMatchObject({
      status: 429,
    });

    gate.resolve();
    await first;
  });

  it('aborts an over-long stream with a timeout error event', async () => {
    const chat = {
      // Never yields — the max-duration timer must fire and abort.
      async *ask() {
        await new Promise(() => undefined);
        yield { type: 'token', text: 'never' } as ChatStreamEvent;
      },
    } as unknown as ChatService;
    const controller = new ChatController(
      chat,
      limits({ idleTimeoutSeconds: 0.05, maxDurationSeconds: 0.05 }),
    );
    const res = fakeResponse();
    await controller.ask(req(), { content: 'q' }, res);

    expect(res.ended).toBe(true);
    const error = res.events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error).toMatchObject({ code: 'timeout' });
  });

  it('releases the slot after a stream ends, so the next one is admitted', async () => {
    const chat = {
      async *ask() {
        yield { type: 'token', text: 'done' } as ChatStreamEvent;
      },
    } as unknown as ChatService;
    const controller = new ChatController(chat, limits({ maxConcurrentPerPrincipal: 1 }));
    await controller.ask(req(), { content: 'q1' }, fakeResponse());
    // The first stream completed and freed the slot — this must not 429.
    await expect(controller.ask(req(), { content: 'q2' }, fakeResponse())).resolves.toBeUndefined();
  });
});

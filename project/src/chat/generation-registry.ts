import { Injectable } from '@nestjs/common';

/**
 * The live generations this process is streaming (issue #532).
 *
 * Stop has to be an EXPLICIT signal, not an inferred one. `askChat` already
 * aborts the fetch when the user switches conversations, and that deliberately
 * keeps storing the full answer ("the message still lands server-side in the
 * conversation it was sent to"). If any disconnect meant "stop", switching
 * threads, closing the tab or a dropped connection would all start truncating
 * answers that were fine.
 *
 * So a stream announces a generation id, and Stop names it. Nothing is
 * inferred, and a client that simply vanishes keeps today's behaviour exactly.
 *
 * IN-PROCESS by design, and the limit worth knowing: the registry lives in the
 * app process holding the stream, so with more than one replica a Stop can
 * land on a replica that is not holding it and do nothing. The compose stack
 * runs a single `app`, so this is correct today; scaling out needs sticky
 * routing or a notify channel, and that is a deliberate deferral rather than
 * an oversight.
 */
@Injectable()
export class GenerationRegistry {
  private readonly live = new Map<string, { ownerId: string; controller: AbortController }>();

  /** Registers a generation and returns the signal its stream should carry. */
  open(id: string, ownerId: string): AbortSignal {
    const controller = new AbortController();
    this.live.set(id, { ownerId, controller });
    return controller.signal;
  }

  /**
   * Stops one generation. Owner-checked: a generation id is unguessable, but
   * the owner check is what makes that irrelevant rather than load-bearing.
   * Returns false when it already finished, which is an ordinary race and not
   * an error: the answer simply completed first.
   */
  stop(id: string, ownerId: string): boolean {
    const entry = this.live.get(id);
    if (!entry || entry.ownerId !== ownerId) return false;
    entry.controller.abort();
    this.live.delete(id);
    return true;
  }

  /** Always called when a stream ends, however it ended. */
  close(id: string): void {
    this.live.delete(id);
  }
}

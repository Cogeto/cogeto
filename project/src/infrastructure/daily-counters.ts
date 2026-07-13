import { Injectable } from '@nestjs/common';

/**
 * In-process per-user, per-day counters (FIX-2 QS-2/QS-6). Backs both the model
 * budget and the capture/upload quota. A single app process serves one tenant
 * (§A.2), so an in-memory counter is the right weight: it stops a runaway loop
 * or an anonymous demo visitor from draining the model budget within the
 * process, resets at UTC midnight, and needs no schema. A process restart
 * clears it — not an attacker-controllable event — and rate limiting plus the
 * nightly reset bound the residual exposure.
 *
 * The clock is injectable so tests can advance the day deterministically.
 */
@Injectable()
export class DailyCounters {
  private day = '';
  private readonly counts = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** UTC calendar day, e.g. "2026-07-13". */
  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    const today = this.today();
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }

  /** Current count for (user, bucket) on today's date. */
  get(userId: string, bucket: string): number {
    this.roll();
    return this.counts.get(`${bucket}:${userId}`) ?? 0;
  }

  /** Increment (user, bucket) by n and return the new total. */
  add(userId: string, bucket: string, n = 1): number {
    this.roll();
    const key = `${bucket}:${userId}`;
    const next = (this.counts.get(key) ?? 0) + n;
    this.counts.set(key, next);
    return next;
  }
}

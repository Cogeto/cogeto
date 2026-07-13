import type { DailyCounters } from './daily-counters';
import type { ModelBudget } from './limits';
import { currentUsageUserId } from './usage-context';

/**
 * The port the model-gateway budget decorator (QS-2) depends on. Kept in
 * infrastructure so the gateway seam imports only a leaf, never a domain
 * module. `currentUserId` returns the principal to charge (from the per-request
 * usage scope) or undefined for unattributed calls (worker pipeline, eval,
 * smokes) — those are never metered here.
 */
export interface ModelUsageMeter {
  currentUserId(): string | undefined;
  /** True while the user is under BOTH their daily call and token caps. */
  hasBudget(userId: string): boolean;
  /** Record a completed call's estimated usage (best-effort; after the call). */
  record(userId: string, tokens: number): void;
}

const CALLS = 'model_calls';
const TOKENS = 'model_tokens';

/**
 * The in-memory daily model budget (QS-2). Reads the attributed user from the
 * per-request usage scope and checks the day's running call/token totals
 * against the configured caps. Enforced only for user-attributed calls, so the
 * worker's pipeline traffic (no usage scope) passes through unmetered.
 */
export class InMemoryModelBudget implements ModelUsageMeter {
  constructor(
    private readonly limits: ModelBudget,
    private readonly counters: DailyCounters,
    private readonly currentUser: () => string | undefined = currentUsageUserId,
  ) {}

  currentUserId(): string | undefined {
    return this.currentUser();
  }

  hasBudget(userId: string): boolean {
    return (
      this.counters.get(userId, CALLS) < this.limits.dailyCalls &&
      this.counters.get(userId, TOKENS) < this.limits.dailyTokens
    );
  }

  record(userId: string, tokens: number): void {
    this.counters.add(userId, CALLS, 1);
    this.counters.add(userId, TOKENS, Math.max(0, Math.ceil(tokens)));
  }
}

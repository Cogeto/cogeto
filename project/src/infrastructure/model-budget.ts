import type { DailyCounters } from './daily-counters';
import type { ModelBudget } from './limits';
import { currentUsageUserId } from './usage-context';

/**
 * The port the model-gateway budget decorator depends on. Kept in
 * infrastructure so the gateway seam imports only a leaf, never a domain
 * module. `currentUserId` returns the principal to charge (from the usage
 * scope) or undefined for unattributed calls (recurring instance-wide jobs,
 * eval, smokes) — those are never metered here.
 *
 * `currentTaskFamily` labels WHAT the spend was for. It is recorded, never
 * enforced: every cap sums across families.
 */
export interface ModelUsageMeter {
  currentUserId(): string | undefined;
  currentTaskFamily(): string | undefined;
  /** True while the user is under BOTH their daily call and token caps. */
  hasBudget(userId: string): Promise<boolean>;
  /** Record a completed call's estimated usage (best-effort; after the call). */
  record(userId: string, tokens: number, taskFamily?: string): Promise<void>;
}

export const MODEL_CALLS_BUCKET = 'model_calls';
export const MODEL_TOKENS_BUCKET = 'model_tokens';

/**
 * The daily model budget. Reads the attributed user from the usage scope and
 * checks the day's running call/token totals against the configured caps.
 *
 * Security audit 2.0 SEC-18/SEC-10: the totals now live in `usage_counter`
 * (durable, one number across the app and the worker) instead of a per-process
 * map, and the WORKER opens a usage scope from the enqueuing principal, so
 * extraction, verification, embedding, dreaming, skill advance and research
 * conclusion are charged to the user who caused them instead of running
 * uncapped.
 */
export class DailyModelBudget implements ModelUsageMeter {
  constructor(
    private readonly limits: ModelBudget,
    private readonly counters: DailyCounters,
    private readonly currentUser: () => string | undefined = currentUsageUserId,
    private readonly taskFamily: () => string | undefined = () => undefined,
  ) {}

  currentUserId(): string | undefined {
    return this.currentUser();
  }

  currentTaskFamily(): string | undefined {
    return this.taskFamily();
  }

  async hasBudget(userId: string): Promise<boolean> {
    const [calls, tokens] = await Promise.all([
      this.counters.get(userId, MODEL_CALLS_BUCKET),
      this.counters.get(userId, MODEL_TOKENS_BUCKET),
    ]);
    return calls < this.limits.dailyCalls && tokens < this.limits.dailyTokens;
  }

  async record(userId: string, tokens: number, taskFamily?: string): Promise<void> {
    const family = taskFamily ?? this.taskFamily() ?? '';
    await this.counters.add(userId, MODEL_CALLS_BUCKET, 1, family);
    await this.counters.add(userId, MODEL_TOKENS_BUCKET, Math.max(0, Math.ceil(tokens)), family);
  }
}

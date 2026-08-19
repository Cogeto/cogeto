import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Usage attribution. An AsyncLocalStorage scope carrying the user model calls
 * made inside it are charged to, so the model-gateway budget decorator can
 * attribute (and cap) them WITHOUT threading a userId through the
 * provider-neutral seam interface.
 *
 * The app opens one scope per HTTP request: the middleware opens it with an
 * empty store and the bearer guard fills in the user id once the principal
 * resolves (guards run inside the middleware's scope). Same-object mutation is
 * visible to every later async step of the request.
 *
 * Security audit 2.0 SEC-10: the WORKER now opens a scope too. Every job whose
 * payload carries `principal_id` (stamped at enqueue time from this same scope)
 * runs under that principal, so pipeline model traffic — extraction,
 * verification, embedding, skill advance, research conclusion — is metered
 * against the user who caused it instead of running uncapped. Recurring
 * instance-wide jobs have no causing user and stay unattributed; the dreaming
 * cycle opens a scope per owner as it reconciles that owner's batch.
 *
 * `taskFamily` labels the work for reporting only; it never affects a cap.
 */

interface UsageStore {
  userId?: string;
  /**
   * The user's Zitadel organization, for audit stamping (V2.0 item 3.7). An
   * `audit_log` row with a NULL org is readable from every org, so the entries
   * the model-egress recorder writes carry one wherever a principal is in scope
   * — the same places `userId` is set, and by the same mechanism.
   */
  orgId?: string;
  /**
   * The space the attributed work happens in (docs/features/spaces.md,
   * session 2). Attribution only, exactly like `orgId`: the model-egress
   * audit entry stamps it so an administrator can filter egress by space.
   * It NEVER affects a cap — budgets and daily caps are instance-wide spend
   * protection by owner decision, and the space a job belongs to is recorded
   * on its subject row, which is where this value comes from in workers.
   */
  spaceId?: string;
  taskFamily?: string;
}

const storage = new AsyncLocalStorage<UsageStore>();

/** Open a fresh usage scope for the duration of `fn`. */
export function runWithUsageContext<T>(fn: () => T, initial: UsageStore = {}): T {
  return storage.run({ ...initial }, fn);
}

/**
 * Fill in the attributed user once the principal is known (the bearer guard;
 * the worker's task wrapper from the job payload). `orgId` is optional because
 * the worker learns the principal from a payload key and not from a Principal.
 */
export function setUsageUser(userId: string, orgId?: string, spaceId?: string): void {
  const store = storage.getStore();
  if (!store) return;
  store.userId = userId;
  if (orgId) store.orgId = orgId;
  if (spaceId) store.spaceId = spaceId;
}

/** Label the current scope's work ('ingestion', 'chat', 'dreaming', …). */
export function setUsageTaskFamily(taskFamily: string): void {
  const store = storage.getStore();
  if (store) store.taskFamily = taskFamily;
}

/** The user to charge for model calls in the current async context, if any. */
export function currentUsageUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/** The attributed user's org, for audit stamping. */
export function currentUsageOrgId(): string | undefined {
  return storage.getStore()?.orgId;
}

/** The attributed work's space, for audit stamping. Never a cap input. */
export function currentUsageSpaceId(): string | undefined {
  return storage.getStore()?.spaceId;
}

/** The current scope's task family, if one was set. */
export function currentUsageTaskFamily(): string | undefined {
  return storage.getStore()?.taskFamily;
}

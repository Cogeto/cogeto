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
  taskFamily?: string;
}

const storage = new AsyncLocalStorage<UsageStore>();

/** Open a fresh usage scope for the duration of `fn`. */
export function runWithUsageContext<T>(fn: () => T, initial: UsageStore = {}): T {
  return storage.run({ ...initial }, fn);
}

/** Fill in the attributed user once the principal is known (the bearer guard). */
export function setUsageUser(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
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

/** The current scope's task family, if one was set. */
export function currentUsageTaskFamily(): string | undefined {
  return storage.getStore()?.taskFamily;
}

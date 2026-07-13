import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request usage attribution (FIX-2 QS-2). An AsyncLocalStorage scope,
 * opened once per HTTP request in the app, carries the authenticated user id so
 * the model-gateway budget decorator can attribute (and cap) model calls to a
 * principal WITHOUT threading a userId through the provider-neutral seam
 * interface. The worker opens no such scope, so its pipeline model calls are
 * unattributed and therefore unmetered — bounded instead by the per-user daily
 * capture/upload quota (QS-6).
 *
 * The store is a mutable object: the middleware opens the scope with an empty
 * store, and the bearer guard fills in the user id once the principal resolves
 * (guards run inside the middleware's scope). Same-object mutation is visible to
 * every later async step of the request.
 */

interface UsageStore {
  userId?: string;
}

const storage = new AsyncLocalStorage<UsageStore>();

/** Open a fresh usage scope for the duration of `fn` (per-request middleware). */
export function runWithUsageContext<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Fill in the attributed user once the principal is known (the bearer guard). */
export function setUsageUser(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}

/** The user to charge for model calls in the current async context, if any. */
export function currentUsageUserId(): string | undefined {
  return storage.getStore()?.userId;
}

import type { QueryClient } from '@tanstack/react-query';

/**
 * Targeted query invalidation after mutations. The dashboard used a
 * bare `queryClient.invalidateQueries` after every mutation, which refetches
 * EVERY active query (health polls, worker activity, unrelated lists) on any
 * change. These groups invalidate only the queries a given mutation can move.
 * React Query matches by key PREFIX, so `['memories']` also refreshes
 * `['memories', params]`, and `['memory']` refreshes every `['memory', id]`
 * citation-chip lookup.
 */

/** Coherent staleness for a cited memory's chip — one named constant. */
export const CITATION_STALE_MS = 60_000;

async function invalidate(qc: QueryClient, keys: readonly unknown[][]): Promise<void> {
  await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** A memory's status/scope/sensitivity/content changed (approve, outdate, edit, …). */
export const invalidateAfterGovernance = (qc: QueryClient): Promise<void> =>
  invalidate(qc, [
    ['memories'],
    ['memory'],
    ['memory-chain'],
    ['verification'],
    ['contradictions'],
  ]);

/** A contradiction was resolved (confirm/correct/dismiss). */
export const invalidateAfterContradiction = (qc: QueryClient): Promise<void> =>
  invalidate(qc, [['contradictions'], ['memories'], ['memory']]);

/** An approval was confirmed (approve/reject); its effect may outdate memories. */
export const invalidateAfterApproval = (qc: QueryClient): Promise<void> =>
  invalidate(qc, [['pending-approvals'], ['approval-history'], ['memories'], ['memory']]);

/** A parked job was retried from the System view. */
export const invalidateAfterJobRetry = (qc: QueryClient): Promise<void> =>
  invalidate(qc, [['dead-letter'], ['worker-activity'], ['health']]);

/**
 * A source was truly deleted — the widest cascade (spec §11.1/spec §11.1): the memories, the
 * Forgotten ledger + chain, the sweep surface, contradictions,
 * and any chat turn that cited the erased facts.
 */
export const invalidateAfterSourceDeletion = (qc: QueryClient): Promise<void> =>
  invalidate(qc, [
    ['memories'],
    ['memory'],
    ['memory-chain'],
    ['receipts'],
    ['chain-status'],
    ['integrity'],
    ['contradictions'],
    ['chat-messages'],
    ['conversations'],
    ['dream-digest'],
  ]);

import { and, eq, or } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';

/** The four columns any gated row carries (spec §1, §4.2;
 * docs/features/spaces.md added the space dimension). */
export interface ScopeGateColumns {
  ownerId: AnyPgColumn;
  scope: AnyPgColumn;
  sensitive: AnyPgColumn;
  spaceId: AnyPgColumn;
}

export interface ScopeGateOptions {
  /**
   * Return the caller's OWN sensitive rows too. Off by default: sensitive rows
   * are excluded from a normal read and returned only to their owner, and only
   * on explicit per-query opt-in (spec §4.2). A peer's sensitive row is never
   * returned under any option.
   */
  includeSensitive?: boolean;
}

/**
 * **The** scope and sensitive gate, as one SQL expression (spec §4.2, §3.4 as
 * amended by 0003 ruling 3; V2.0 item 3.7 made it one definition).
 *
 * - scope: the caller's own rows, or rows marked `shared`.
 * - sensitive: excluded by default; with the opt-in, still owner-only.
 *
 * These are HARD gates: they go in the WHERE clause, never into a score and
 * never into an app-side filter over results. A demoted leak is still a leak.
 *
 * It was written out twice, character for character, over two different tables:
 * `memory` (`MemoryStore.visibleTo`) and `suppressed_fact_log`
 * (V2.0 item 3.3, whose comment said "character for character the memory rule"
 * and then said it again). Two copies of a gate is two places to get it wrong,
 * so it is defined here, parameterised by the COLUMNS and by nothing else — no
 * flag changes what the gate means, and the sensitive opt-in is the same
 * per-query option the specification already defines.
 *
 * The Qdrant twin, `buildGateFilter` in `persistence/vector-store.ts`, stays
 * separate on purpose: it is the same rule in a different language (native
 * payload pre-filters, not SQL), and collapsing them would mean generating one
 * from the other. It is kept in parity by test, which is the honest mechanism
 * for a cross-language twin.
 */
export function visibleToPrincipal(
  columns: ScopeGateColumns,
  principal: Principal,
  options: ScopeGateOptions = {},
): SQL {
  const own = eq(columns.ownerId, principal.userId);
  const scopeGate = or(own, eq(columns.scope, 'shared'))!;
  const sensitiveGate = options.includeSensitive
    ? or(eq(columns.sensitive, false), own)!
    : eq(columns.sensitive, false);
  // The space gate (docs/features/spaces.md): the caller's current space,
  // resolved through the one shared fallback so absence can never mean "all
  // spaces". An equality like the owner arm, never an option: no flag
  // weakens it and no caller can decline it.
  const spaceGate = eq(columns.spaceId, resolveSpaceId(principal));
  return and(scopeGate, sensitiveGate, spaceGate)!;
}

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type {
  AttentionFeedDto,
  AttentionItem,
  AttentionKind,
  DailyPoint,
  DailySeries,
  DashboardStatsDto,
  Principal,
} from '@cogeto/shared';
import {
  attentionDismissal,
  attentionState,
  DRIZZLE,
  UserContextService,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryReconciliation, MemoryStore } from '../memory/index';
import { RetrievalService } from '../retrieval/index';
import type { OpenLoop } from '../retrieval/index';
import { ApprovalService } from '../agents/index';
import { buildDreamDigest, dreamingActivityForPrincipal } from '../ingestion/index';

/**
 * The "what needs my attention" surface and the dashboard statistics (
 *). Both are COMPUTED per Principal — a thin derived
 * layer over signals the instance already produces (the open loops read from
 * memory, the review queues, pending approvals, the dreaming digest). The only materialized state is the
 * read-state pair (`attention_state`, `attention_dismissal`).
 *
 * Composition root placement (entrypoints): the surface spans four bounded
 * contexts, so it lives with the other cross-cutting controllers (audit, jobs)
 * and reaches each module ONLY through its public interface — every count and
 * every line comes back already gated, never a raw table read of a domain
 * module (spec §15).
 */

/** An open loop within this window is "due soon" (past it, simply overdue). */
const DUE_SOON_HOURS = 72;
/** Days of history the dashboard series cover — a bounded, cheap window. */
const STATS_WINDOW_DAYS = 30;
/** Cap the per-item feed so a flood of approvals/digest lines never unbounds it. */
const MAX_ITEMS_PER_GROUP = 8;

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

/** Display priority — most-pressing first; ties break on recency. */
const PRIORITY: Record<AttentionKind, number> = {
  open_loop_overdue: 0,
  review_contradicted: 1,
  approval_pending: 2,
  open_loop_due_soon: 3,
  open_loop_quiet: 4,
  review_uncertain: 5,
  digest_change: 6,
};

@Injectable()
export class AttentionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memoryStore: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
    /** The one open-loops query — the same read the chat
     * answer uses, so "still open" means one thing across the product. */
    private readonly retrieval: RetrievalService,
    private readonly approvals: ApprovalService,
    private readonly userContext: UserContextService,
  ) {}

  // ── Feed ────────────────────────────────────────────────────────────────────

  async getFeed(principal: Principal): Promise<AttentionFeedDto> {
    const now = new Date();
    // Attention lines are Cogeto-initiated copy: they speak the user's
    // preferred language.
    const hr =
      (await this.userContext.preferredLanguageFor(principal.userId).catch(() => 'en' as const)) ===
      'hr';
    const [lastSeenAt, dismissed] = await Promise.all([
      this.lastSeenAt(principal.userId),
      this.dismissedKeys(principal.userId),
    ]);

    const groups = await Promise.all([
      this.openLoopItems(principal, now, hr),
      this.reviewItems(principal, hr),
      this.approvalItems(principal, hr),
      this.digestItems(principal, hr),
    ]);
    const raw = groups.flat().filter((item) => !dismissed.has(item.key));

    const items = raw
      .map((item) => ({
        ...item,
        unread: lastSeenAt === null || item.timestamp > lastSeenAt.toISOString(),
      }))
      .sort(byPriorityThenRecency);

    return {
      items,
      unreadCount: items.filter((i) => i.unread).length,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
    };
  }

  /** Open loops due soon / overdue / gone quiet — gated, then classified. */
  private async openLoopItems(
    principal: Principal,
    now: Date,
    hr: boolean,
  ): Promise<Omit<AttentionItem, 'unread'>[]> {
    const loops = await this.retrieval.openLoops(principal);
    const items: Omit<AttentionItem, 'unread'>[] = [];
    for (const loop of loops) {
      const classified = classifyOpenLoop(loop, now, hr);
      if (classified) items.push(classified);
    }
    // Quiet nudges are the calmest; keep the count honest but bounded.
    return capGroup(items);
  }

  /** The two review queues as live counts (never dismissible). */
  private async reviewItems(
    principal: Principal,
    hr: boolean,
  ): Promise<Omit<AttentionItem, 'unread'>[]> {
    const [uncertainCount, uncertainNewest, contradictions] = await Promise.all([
      this.memoryStore.countForPrincipal(principal, {
        status: 'uncertain',
        mine: true,
        includeSensitive: true,
      }),
      this.memoryStore.listForPrincipal(principal, {
        status: 'uncertain',
        mine: true,
        includeSensitive: true,
        limit: 1,
      }),
      this.reconciliation.listOpenContradictions(principal),
    ]);

    const items: Omit<AttentionItem, 'unread'>[] = [];
    if (uncertainCount > 0) {
      const newest = uncertainNewest[0]?.createdAt ?? new Date();
      items.push({
        key: 'review:uncertain',
        kind: 'review_uncertain',
        title: hr
          ? `${hrCount(uncertainCount, 'činjenica čeka', 'činjenice čekaju', 'činjenica čeka')} tvoju provjeru`
          : `${plural(uncertainCount, 'fact')} awaiting your review`,
        timestamp: newest.toISOString(),
        href: '/review',
        count: uncertainCount,
        dismissible: false,
      });
    }
    if (contradictions.length > 0) {
      const newest = contradictions.reduce(
        (max, c) => (c.relation.detectedAt > max ? c.relation.detectedAt : max),
        contradictions[0]!.relation.detectedAt,
      );
      items.push({
        key: 'review:contradicted',
        kind: 'review_contradicted',
        title: hr
          ? `${hrCount(contradictions.length, 'sukob', 'sukoba', 'sukoba')} za rješavanje`
          : `${plural(contradictions.length, 'conflict')} to resolve`,
        timestamp: newest.toISOString(),
        href: '/review?tab=contradicted',
        count: contradictions.length,
        dismissible: false,
      });
    }
    return items;
  }

  /** Pending consequential actions awaiting a decision (never dismissible). */
  private async approvalItems(
    principal: Principal,
    hr: boolean,
  ): Promise<Omit<AttentionItem, 'unread'>[]> {
    const pending = await this.approvals.listPending(principal);
    return capGroup(
      pending.map((approval) => ({
        key: `approval:${approval.id}`,
        kind: 'approval_pending' as const,
        title: hr
          ? `Čeka tvoje odobrenje, ${approval.summary}`
          : `Waiting for your approval, ${approval.summary}`,
        timestamp: approval.createdAt ?? new Date(0).toISOString(),
        href: '/approvals',
        dismissible: false,
      })),
    );
  }

  /** Last night's consolidation — the digest lines, each dismissible. */
  private async digestItems(
    principal: Principal,
    hr: boolean,
  ): Promise<Omit<AttentionItem, 'unread'>[]> {
    const digest = await buildDreamDigest(this.db, this.memoryStore, principal, {
      locale: hr ? 'hr' : 'en',
    });
    if (!digest.runId || !digest.finishedAt) return [];
    return digest.lines.map((line, index) => ({
      // Content-free key: run id + position in the deterministic line order.
      key: `digest:${digest.runId}:${index}`,
      kind: 'digest_change' as const,
      title: line.text,
      timestamp: digest.finishedAt!,
      href: line.href,
      dismissible: true,
    }));
  }

  // ── Read-state ────────────────────────────────────────────────────────────

  async markSeen(principal: Principal): Promise<string> {
    const now = new Date();
    await this.db
      .insert(attentionState)
      .values({ ownerId: principal.userId, lastSeenAt: now })
      .onConflictDoUpdate({ target: attentionState.ownerId, set: { lastSeenAt: now } });
    return now.toISOString();
  }

  async dismiss(principal: Principal, key: string): Promise<void> {
    // Only digest lines are dismissible; a live count ("3 items in review") is
    // never dismissed — it clears when the work is done, not when hidden.
    if (!key.startsWith('digest:')) {
      throw new BadRequestException('only digest items can be dismissed');
    }
    await this.db
      .insert(attentionDismissal)
      .values({ ownerId: principal.userId, itemKey: key })
      .onConflictDoNothing();
  }

  private async lastSeenAt(ownerId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ lastSeenAt: attentionState.lastSeenAt })
      .from(attentionState)
      .where(eq(attentionState.ownerId, ownerId))
      .limit(1);
    return rows[0]?.lastSeenAt ?? null;
  }

  private async dismissedKeys(ownerId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ itemKey: attentionDismissal.itemKey })
      .from(attentionDismissal)
      .where(eq(attentionDismissal.ownerId, ownerId));
    return new Set(rows.map((r) => r.itemKey));
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async getStats(principal: Principal): Promise<DashboardStatsDto> {
    const [
      memoryByStatus,
      openLoops,
      sourceRows,
      dreamRows,
      oldestUncertain,
      uncertainReview,
      contradictions,
      pending,
    ] = await Promise.all([
      this.memoryStore.statusCountsForPrincipal(principal),
      this.retrieval.openLoops(principal),
      this.memoryStore.sourceDailyCountsForPrincipal(principal, STATS_WINDOW_DAYS),
      dreamingActivityForPrincipal(this.db, this.memoryStore, principal, STATS_WINDOW_DAYS),
      this.memoryStore.oldestUncertainAtForPrincipal(principal),
      // Owner-only, mirroring the Review queue and the feed (not the broader
      // own+shared "memory by status" governance view).
      this.memoryStore.countForPrincipal(principal, {
        status: 'uncertain',
        mine: true,
        includeSensitive: true,
      }),
      this.reconciliation.listOpenContradictions(principal),
      this.approvals.listPending(principal),
    ]);

    const memoryTotal = Object.values(memoryByStatus).reduce((a, b) => a + b, 0);

    // Sources: fold source types into the three families the buyer recognises.
    const sources = buildSeries(
      STATS_WINDOW_DAYS,
      ['notes', 'email', 'files'],
      sourceRows.map((r) => ({ day: r.day, key: SOURCE_FAMILY[r.sourceType], value: r.sources })),
    );
    // Dreaming: merges (dedup + supersession) vs conflicts caught.
    const dreaming = buildSeries(
      STATS_WINDOW_DAYS,
      ['merges', 'conflicts'],
      dreamRows.map((r) => ({
        day: r.day,
        key: r.pass === 'contradiction' ? 'conflicts' : 'merges',
        value: r.count,
      })),
    );

    const oldestContradiction = contradictions.reduce<Date | null>(
      (min, c) => (min === null || c.relation.detectedAt < min ? c.relation.detectedAt : min),
      null,
    );
    const oldestAt = earliest(oldestUncertain, oldestContradiction);

    return {
      memoryByStatus,
      memoryTotal,
      openLoops: openLoops.length,
      sources,
      dreaming,
      review: {
        uncertain: uncertainReview,
        contradicted: contradictions.length,
        oldestAt: oldestAt?.toISOString() ?? null,
      },
      approvalsPending: pending.length,
    };
  }
}

/** Source-type → chart family. calendar/task_conclusion are engine/derived (the
 * latter defunct since), not user-ingested sources, so they are
 * excluded from the "sources" chart. */
const SOURCE_FAMILY: Record<string, string> = {
  user_note: 'notes',
  chat: 'notes',
  email: 'email',
  file: 'files',
};

/**
 * One open loop → at most one attention line. Due date is the
 * memory's own `valid_until`; "gone quiet" is ingestion's dormant flag; the
 * deep link opens the fact itself in the memory drawer, where its provenance
 * and validity live.
 */
function classifyOpenLoop(
  loop: OpenLoop,
  now: Date,
  hr: boolean,
): Omit<AttentionItem, 'unread'> | null {
  const { memory } = loop;
  const href = `/memories?open=${memory.id}`;
  const title = trim(memory.content ?? '');
  const nowMs = now.getTime();
  if (memory.validUntil) {
    const dueMs = memory.validUntil.getTime();
    if (dueMs < nowMs) {
      const days = Math.max(1, Math.round((nowMs - dueMs) / MS_DAY));
      return {
        key: `loop:${memory.id}:overdue`,
        kind: 'open_loop_overdue',
        title: hr
          ? `Kasni ${days === 1 ? '1 dan' : `${days} dana`}: ${title}`
          : `Overdue by ${plural(days, 'day')}: ${title}`,
        timestamp: memory.validUntil.toISOString(),
        href,
        dismissible: false,
      };
    }
    if (dueMs <= nowMs + DUE_SOON_HOURS * MS_HOUR) {
      const days = Math.round((dueMs - nowMs) / MS_DAY);
      const when = hr
        ? days <= 0
          ? 'danas'
          : days === 1
            ? 'sutra'
            : `za ${days} dana`
        : days <= 0
          ? 'today'
          : days === 1
            ? 'tomorrow'
            : `in ${days} days`;
      return {
        key: `loop:${memory.id}:due`,
        kind: 'open_loop_due_soon',
        title: hr ? `Rok ${when}: ${title}` : `Due ${when}: ${title}`,
        // The moment it entered the due-soon window (past), so "new" is honest.
        timestamp: new Date(dueMs - DUE_SOON_HOURS * MS_HOUR).toISOString(),
        href,
        dismissible: false,
      };
    }
  }
  if (loop.dormant) {
    return {
      key: `loop:${memory.id}:quiet`,
      kind: 'open_loop_quiet',
      title: hr ? `Utihnulo: ${title}` : `Gone quiet: ${title}`,
      timestamp: memory.updatedAt.toISOString(),
      href,
      dismissible: false,
    };
  }
  return null;
}

/** Fill a bounded daily series: one point per UTC day, families zero-filled. */
function buildSeries(
  days: number,
  keys: string[],
  rows: Array<{ day: string; key: string | undefined; value: number }>,
): DailySeries {
  const byDay = new Map<string, Record<string, number>>();
  const todayMs = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(todayMs - i * MS_DAY).toISOString().slice(0, 10);
    byDay.set(date, Object.fromEntries(keys.map((k) => [k, 0])));
  }
  for (const row of rows) {
    if (!row.key) continue; // a source type outside the tracked families
    const bucket = byDay.get(row.day);
    if (bucket && row.key in bucket) bucket[row.key] = (bucket[row.key] ?? 0) + row.value;
  }
  const series: DailyPoint[] = [...byDay.entries()].map(([date, counts]) => ({ date, counts }));
  return { days, keys, series };
}

function capGroup<T>(items: T[]): T[] {
  return items.slice(0, MAX_ITEMS_PER_GROUP);
}

function byPriorityThenRecency(a: AttentionItem, b: AttentionItem): number {
  const byKind = PRIORITY[a.kind] - PRIORITY[b.kind];
  return byKind !== 0 ? byKind : b.timestamp.localeCompare(a.timestamp);
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

/** Croatian count phrase: singular (1), paucal (2-4), genitive (5+). */
function hrCount(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

function trim(title: string): string {
  const t = title.trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

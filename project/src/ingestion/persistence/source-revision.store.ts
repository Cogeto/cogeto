import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, userError, writeAudit } from '../../infrastructure/index';
import type { Db, DbOrTx, Tx } from '../../infrastructure/index';
import { sourceRevision } from './tables';
import type { RevisionBasis, SourceRevisionRow } from './tables';

/**
 * The document revision link (V2.2 item 5.3). The decision record is
 * docs/features/revisions.md and this file implements it verbatim: candidates
 * are nominated structurally (same normalized filename, different hash),
 * corroboration decides, and below the bar NOTHING is recorded. A rejected
 * pair is remembered by its unique row and never re-proposed.
 */

/** Frozen thresholds (the reconcile-config precedent: constants with their
 * rationale, moved only by a reviewed change). */
export const REVISION_SUBJECT_OVERLAP_MIN = 0.5; // half the confident subjects agree
export const REVISION_SHINGLE_SIMILARITY_MIN = 0.6; // same document, edited — not same topic

export interface RevisionRef {
  sourceType: string;
  sourceId: string;
}

@Injectable()
export class SourceRevisionStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Records a DETECTED relationship (auto or proposed). Never overwrites an
   * existing decision: a rejected pair stays rejected (the never-re-propose
   * rule), and a confirmed/manual link is the owner's word.
   */
  async recordDetected(
    db: DbOrTx,
    entry: {
      ownerId: string;
      /** The space both endpoints live in (docs/features/spaces.md): callers
       * nominate candidates within one container, which lives in one space,
       * so a link can only ever join same-space sources. REQUIRED (section
       * 6d): both machine writers carry their row's space. */
      spaceId: string;
      successor: RevisionRef;
      predecessor: RevisionRef;
      status: 'auto' | 'proposed';
      basis: RevisionBasis;
    },
  ): Promise<SourceRevisionRow | null> {
    const inserted = await db
      .insert(sourceRevision)
      .values({
        ownerId: entry.ownerId,
        spaceId: entry.spaceId,
        successorType: entry.successor.sourceType,
        successorId: entry.successor.sourceId,
        predecessorType: entry.predecessor.sourceType,
        predecessorId: entry.predecessor.sourceId,
        status: entry.status,
        basisJson: entry.basis,
        decidedAt: entry.status === 'auto' ? new Date() : null,
      })
      .onConflictDoNothing()
      .returning();
    return inserted[0] ?? null;
  }

  /** Confirm / reject a proposed (or auto) link; owner-only, audited. */
  async decide(
    principal: Principal,
    revisionId: string,
    decision: 'confirmed' | 'rejected',
  ): Promise<SourceRevisionRow> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sourceRevision)
        .where(
          and(
            eq(sourceRevision.id, revisionId),
            eq(sourceRevision.ownerId, principal.userId),
            // A link reached by id from another space reads as not found,
            // like every by-id read (docs/features/spaces.md).
            eq(sourceRevision.spaceId, resolveSpaceId(principal)),
          ),
        )
        .for('update');
      const row = rows[0];
      if (!row)
        throw userError.notFound('revision.notFound', 'revision link {{id}} not found', {
          id: revisionId,
        });
      const [updated] = await tx
        .update(sourceRevision)
        .set({ status: decision, decidedAt: new Date() })
        .where(eq(sourceRevision.id, revisionId))
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: `source_revision.${decision}`,
        entityType: 'source_revision',
        entityId: revisionId,
        detail: {
          successor: `${row.successorType}/${row.successorId}`,
          predecessor: `${row.predecessorType}/${row.predecessorId}`,
          priorStatus: row.status,
        },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: row.spaceId,
      });
      return updated!;
    });
  }

  /** A manual link from the Sources view; owner-only, audited. */
  async linkManually(
    principal: Principal,
    successor: RevisionRef,
    predecessor: RevisionRef,
  ): Promise<SourceRevisionRow> {
    if (
      successor.sourceType === predecessor.sourceType &&
      successor.sourceId === predecessor.sourceId
    ) {
      throw userError.badRequest('revision.selfLink', 'a source cannot be a revision of itself');
    }
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(sourceRevision)
        .values({
          ownerId: principal.userId,
          spaceId: resolveSpaceId(principal),
          successorType: successor.sourceType,
          successorId: successor.sourceId,
          predecessorType: predecessor.sourceType,
          predecessorId: predecessor.sourceId,
          status: 'manual',
          basisJson: {
            filename: null,
            revisionNew: null,
            revisionOld: null,
            subjectOverlap: null,
            classMatch: null,
            shingleSimilarity: null,
            confidence: 'manual',
          },
          decidedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            sourceRevision.ownerId,
            sourceRevision.successorType,
            sourceRevision.successorId,
            sourceRevision.predecessorType,
            sourceRevision.predecessorId,
          ],
          // The owner's explicit link overrides a machine proposal or an
          // earlier rejection — manual control cuts both ways.
          set: { status: 'manual', decidedAt: new Date() },
        })
        .returning();
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'source_revision.manual_link',
        entityType: 'source_revision',
        entityId: inserted[0]!.id,
        detail: {
          successor: `${successor.sourceType}/${successor.sourceId}`,
          predecessor: `${predecessor.sourceType}/${predecessor.sourceId}`,
        },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: resolveSpaceId(principal),
      });
      return inserted[0]!;
    });
  }

  /** The links touching one source, either side, newest first. Owner-only,
   * and space-scoped like every other read of a space-carrying table: the
   * endpoint ref is already space-gated by the caller, so this condition is
   * the row's own seal, not the primary gate. */
  async forSource(principal: Principal, ref: RevisionRef): Promise<SourceRevisionRow[]> {
    return this.db
      .select()
      .from(sourceRevision)
      .where(
        and(
          eq(sourceRevision.ownerId, principal.userId),
          eq(sourceRevision.spaceId, resolveSpaceId(principal)),
          or(
            and(
              eq(sourceRevision.successorType, ref.sourceType),
              eq(sourceRevision.successorId, ref.sourceId),
            ),
            and(
              eq(sourceRevision.predecessorType, ref.sourceType),
              eq(sourceRevision.predecessorId, ref.sourceId),
            ),
          ),
        ),
      )
      .orderBy(desc(sourceRevision.createdAt));
  }

  /** Deletion-cascade leg: links naming these sources on either side. */
  async deleteForSources(tx: Tx, refs: readonly RevisionRef[]): Promise<number> {
    if (refs.length === 0) return 0;
    const clauses = refs.map((ref) =>
      or(
        and(
          eq(sourceRevision.successorType, ref.sourceType),
          eq(sourceRevision.successorId, ref.sourceId),
        ),
        and(
          eq(sourceRevision.predecessorType, ref.sourceType),
          eq(sourceRevision.predecessorId, ref.sourceId),
        ),
      )!,
    );
    const removed = await tx
      .delete(sourceRevision)
      .where(or(...clauses)!)
      .returning({ id: sourceRevision.id });
    return removed.length;
  }
}

// ── The scorer: pure, threshold-frozen, unit-tested ─────────────────────────

/** Case-folded basename: `Reports/Q3 Final.PDF` → `q3 final.pdf`. */
export function normalizeFilename(name: string): string {
  const base = name.split('/').pop() ?? name;
  return base.trim().toLowerCase();
}

/**
 * Parses an anchored revision field under the two schemes documents actually
 * use: dotted numbers (`2`, `v2.1`, `rev 3.0.1`) and ISO-ish dates. Returns
 * null for anything else — an unparseable revision corroborates nothing.
 */
export function parseRevisionField(
  value: string | null | undefined,
): { scheme: 'numeric' | 'date'; key: number[] } | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  const date = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (date) {
    return { scheme: 'date', key: [Number(date[1]), Number(date[2]), Number(date[3] ?? '1')] };
  }
  const numeric = trimmed.match(/^(?:rev(?:ision)?\.?\s*|v\.?\s*)?(\d+(?:\.\d+)*)$/);
  if (numeric) {
    return { scheme: 'numeric', key: numeric[1]!.split('.').map(Number) };
  }
  return null;
}

/** True iff both parse under ONE scheme and `next` is strictly later. */
export function revisionIsLater(next: string | null, prev: string | null): boolean {
  const a = parseRevisionField(next);
  const b = parseRevisionField(prev);
  if (!a || !b || a.scheme !== b.scheme) return false;
  const length = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.key[i] ?? 0;
    const y = b.key[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Jaccard overlap of case-folded confident subject names. */
export function subjectOverlap(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(b.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const name of setA) if (setB.has(name)) hits += 1;
  return hits / (setA.size + setB.size - hits);
}

const SHINGLE_TOKENS = 8;

/** Jaccard similarity over 8-token shingles: cheap structural similarity that
 * distinguishes an edited document from a merely same-topic one. */
export function shingleSimilarity(a: string, b: string): number {
  const shingles = (text: string): Set<string> => {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + SHINGLE_TOKENS <= tokens.length; i += 1) {
      out.add(tokens.slice(i, i + SHINGLE_TOKENS).join(' '));
    }
    // A document shorter than one shingle is its own shingle.
    if (out.size === 0 && tokens.length > 0) out.add(tokens.join(' '));
    return out;
  };
  const setA = shingles(a);
  const setB = shingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const s of setA) if (setB.has(s)) hits += 1;
  return hits / (setA.size + setB.size - hits);
}

/**
 * The decision, verbatim from docs/features/revisions.md: S1 (comparable
 * anchored revisions, new later, classes not disagreeing) links `auto` at
 * `high`; S2 (subject overlap ≥ 0.5 AND class match AND shingle similarity ≥
 * 0.6) proposes at `medium`; anything else records NOTHING.
 */
export function scoreRevision(basis: Omit<RevisionBasis, 'confidence'>): {
  decision: 'auto' | 'proposed';
  confidence: 'high' | 'medium';
} | null {
  const classesDisagree = basis.classMatch === false;
  if (revisionIsLater(basis.revisionNew, basis.revisionOld) && !classesDisagree) {
    return { decision: 'auto', confidence: 'high' };
  }
  if (
    (basis.subjectOverlap ?? 0) >= REVISION_SUBJECT_OVERLAP_MIN &&
    basis.classMatch === true &&
    (basis.shingleSimilarity ?? 0) >= REVISION_SHINGLE_SIMILARITY_MIN
  ) {
    return { decision: 'proposed', confidence: 'medium' };
  }
  return null;
}

/** Grouped revision outcomes for a set of successor keys (V2.2 item 5.3):
 * the import summary's linked/proposed numbers, table named only here. The
 * space condition rides INSIDE the query like every other read in this file
 * (docs/features/spaces.md section 6c): successor ids are per-space material
 * already, but an aggregate computed without the dimension is the class of
 * read the isolation sessions exist to remove. */
export async function revisionCountsForSuccessors(
  db: DbOrTx,
  spaceId: string,
  successorKeys: readonly string[],
): Promise<{ linked: number; proposed: number }> {
  if (successorKeys.length === 0) return { linked: 0, proposed: 0 };
  const rows = await db
    .select({ status: sourceRevision.status, n: sql<number>`count(*)::int` })
    .from(sourceRevision)
    .where(
      and(
        eq(sourceRevision.spaceId, spaceId),
        eq(sourceRevision.successorType, 'file'),
        inArray(sourceRevision.successorId, [...successorKeys]),
      ),
    )
    .groupBy(sourceRevision.status);
  let linked = 0;
  let proposed = 0;
  for (const row of rows) {
    if (row.status === 'proposed') proposed += row.n;
    else if (row.status !== 'rejected') linked += row.n;
  }
  return { linked, proposed };
}

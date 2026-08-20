import { Inject, Injectable } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../../infrastructure/index';
import type { Db, DbOrTx, Tx } from '../../infrastructure/index';
import { sourceContext } from './tables';
import type { SourceContextRow, SourceContextSubject } from './tables';

/**
 * The source-context store (V2.1 item 4.2, spec 1.5): one row per source
 * holding what the document as a whole is about. Written by the pipeline's
 * anchor stage inside the ingestion transaction; read back by the same stage
 * on a re-run; edited by the owner through ingestion's controller, after which
 * the anchor call never overwrites it (spec 1.5.3).
 */

/** The anchor result as the pipeline carries it, storage-independent. */
export interface SourceContextValue {
  subjects: SourceContextSubject[];
  documentClass: string | null;
  documentClassConfident: boolean;
  revision: string | null;
  revisionConfident: boolean;
}

@Injectable()
export class SourceContextStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(tx: DbOrTx, sourceType: string, sourceId: string): Promise<SourceContextRow | null> {
    const rows = await tx
      .select()
      .from(sourceContext)
      .where(and(eq(sourceContext.sourceType, sourceType), eq(sourceContext.sourceId, sourceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Records a machine-produced context, inside the pipeline's transaction. A
   * user-edited row is never overwritten here: the edit is authoritative and
   * the anchor stage checks before calling the model at all; the WHERE clause
   * is the belt for a race.
   */
  async recordMachine(
    tx: Tx,
    entry: {
      ownerId: string;
      /** The source row's space (docs/features/spaces.md), stamped with the
       * row. REQUIRED (section 6d): the anchoring context is the document's
       * own words and must land where the document lives. */
      spaceId: string;
      sourceType: string;
      sourceId: string;
      context: SourceContextValue;
      promptVersion: string;
    },
  ): Promise<void> {
    const existing = await this.get(tx, entry.sourceType, entry.sourceId);
    if (existing) {
      if (existing.editedByUser) return;
      await tx
        .update(sourceContext)
        .set({
          subjects: entry.context.subjects,
          documentClass: entry.context.documentClass,
          documentClassConfident: entry.context.documentClassConfident,
          revision: entry.context.revision,
          revisionConfident: entry.context.revisionConfident,
          promptVersion: entry.promptVersion,
          updatedAt: new Date(),
        })
        .where(and(eq(sourceContext.id, existing.id), eq(sourceContext.editedByUser, false)));
      return;
    }
    await tx.insert(sourceContext).values({
      ownerId: entry.ownerId,
      spaceId: entry.spaceId,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      subjects: entry.context.subjects,
      documentClass: entry.context.documentClass,
      documentClassConfident: entry.context.documentClassConfident,
      revision: entry.context.revision,
      revisionConfident: entry.context.revisionConfident,
      promptVersion: entry.promptVersion,
    });
  }

  /** The owner's view of one source's context; a foreign source reads null. */
  async getForOwner(
    principal: Principal,
    sourceType: string,
    sourceId: string,
  ): Promise<SourceContextRow | null> {
    const rows = await this.db
      .select()
      .from(sourceContext)
      .where(
        and(
          eq(sourceContext.ownerId, principal.userId),
          eq(sourceContext.sourceType, sourceType),
          eq(sourceContext.sourceId, sourceId),
          // Sealed with its space like every principal read
          // (docs/features/spaces.md): the row's subjects and revision are
          // the document's own words.
          eq(sourceContext.spaceId, resolveSpaceId(principal)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A user's correction (spec 1.5.3): upserts the row as edited-by-user, which
   * makes it authoritative — the anchor stage reuses it verbatim from then on.
   * `prompt_version` goes NULL: the row now records the user's words, not a
   * model's. Audited with structural detail only, never the values.
   */
  async setForOwner(
    principal: Principal,
    sourceType: string,
    sourceId: string,
    context: SourceContextValue,
  ): Promise<SourceContextRow> {
    return this.db.transaction(async (tx) => {
      const existing = await this.get(tx, sourceType, sourceId);
      if (
        existing &&
        (existing.ownerId !== principal.userId ||
          // The wall has no owner exception (docs/features/spaces.md): a row
          // in another space is not the caller's to edit either.
          existing.spaceId !== resolveSpaceId(principal))
      ) {
        // A foreign source's context is not the caller's to edit; behave as if
        // it does not exist rather than confirm it does.
        throw new Error('source context not found for this owner');
      }
      const values = {
        subjects: context.subjects,
        documentClass: context.documentClass,
        documentClassConfident: context.documentClassConfident,
        revision: context.revision,
        revisionConfident: context.revisionConfident,
        editedByUser: true,
        promptVersion: null,
        updatedAt: new Date(),
      };
      const row = existing
        ? (
            await tx
              .update(sourceContext)
              .set(values)
              .where(eq(sourceContext.id, existing.id))
              .returning()
          )[0]!
        : (
            await tx
              .insert(sourceContext)
              .values({
                ownerId: principal.userId,
                spaceId: resolveSpaceId(principal),
                sourceType,
                sourceId,
                ...values,
              })
              .returning()
          )[0]!;
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'source_context.edited',
        entityType: 'source_context',
        entityId: row.id,
        detail: {
          sourceType,
          subjectCount: context.subjects.length,
          hasDocumentClass: context.documentClass !== null,
          hasRevision: context.revision !== null,
        },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId: resolveSpaceId(principal),
      });
      return row;
    });
  }

  /** Deletion-saga leg: the context is the document's own words, so it goes
   * with its source and is counted on the receipt. */
  async deleteForSources(
    tx: Tx,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<number> {
    if (refs.length === 0) return 0;
    const clauses = refs.map((ref) =>
      and(eq(sourceContext.sourceType, ref.sourceType), eq(sourceContext.sourceId, ref.sourceId))!,
    );
    const removed = await tx
      .delete(sourceContext)
      .where(or(...clauses)!)
      .returning({ id: sourceContext.id });
    return removed.length;
  }
}

/** Composition helper for non-Nest callers (integration tests, eval). */
export function createSourceContextStore(db: Db): SourceContextStore {
  return new SourceContextStore(db);
}

/**
 * Grouped context reads for the source catalog (V2.2 item 5.2), plain
 * functions in the `latestGateRefusalFor` shape: the anchored first subject
 * names a document whose filename is gone (a discarded original), and the
 * inspection view needs verifications joined to a page of memories without a
 * cross-module table read.
 */
export async function contextNamesForSources(
  db: DbOrTx,
  ownerId: string,
  refs: readonly { sourceType: string; sourceId: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (refs.length === 0) return out;
  const pairs = refs.map((ref) => sql`(${ref.sourceType}, ${ref.sourceId})`);
  const rows = await db
    .select({
      sourceType: sourceContext.sourceType,
      sourceId: sourceContext.sourceId,
      subjects: sourceContext.subjects,
    })
    .from(sourceContext)
    .where(
      and(
        eq(sourceContext.ownerId, ownerId),
        sql`(${sourceContext.sourceType}, ${sourceContext.sourceId}) IN (${sql.join(pairs, sql`, `)})`,
      ),
    );
  for (const row of rows) {
    const first = (row.subjects ?? [])[0]?.name?.trim();
    if (first) out.set(`${row.sourceType} ${row.sourceId}`, first);
  }
  return out;
}

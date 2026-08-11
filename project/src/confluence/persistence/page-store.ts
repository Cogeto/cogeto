import { Inject, Injectable } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import { confluencePage } from './tables';
import type { ConfluencePageRow } from './tables';

/** What one provenance row records about its source. */
export interface ConfluenceProvenance {
  kind: 'page' | 'attachment';
  pageId: string;
  attachmentId?: string | null;
  title: string | null;
  spaceKey: string | null;
  spaceName: string | null;
  version: number | null;
  url: string | null;
  parentPageId?: string | null;
  parentTitle?: string | null;
}

/**
 * The one provenance write, standalone so the descriptor's annotate hook
 * (a plain closure the platform calls with its own executor) needs no
 * injector. Upsert on the source ref: annotate is fail-safe and re-runnable.
 */
export async function recordConfluenceProvenance(
  db: DbOrTx,
  input: {
    ownerId: string;
    orgId: string;
    connectorId: string;
    sourceType: string;
    sourceId: string;
  } & ConfluenceProvenance,
): Promise<void> {
  await db
    .insert(confluencePage)
    .values({
      ownerId: input.ownerId,
      orgId: input.orgId,
      connectorId: input.connectorId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      kind: input.kind,
      pageId: input.pageId,
      attachmentId: input.attachmentId ?? null,
      title: input.title,
      spaceKey: input.spaceKey,
      spaceName: input.spaceName,
      version: input.version,
      url: input.url,
      parentPageId: input.parentPageId ?? null,
      parentTitle: input.parentTitle ?? null,
    })
    .onConflictDoUpdate({
      target: [confluencePage.sourceType, confluencePage.sourceId],
      set: {
        title: input.title,
        spaceKey: input.spaceKey,
        spaceName: input.spaceName,
        version: input.version,
        url: input.url,
        parentPageId: input.parentPageId ?? null,
        parentTitle: input.parentTitle ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * The confluence provenance reads (V2.5 item 8.2, issue D2), owner-gated.
 * The row is content-bearing and erased with its source by
 * ConfluencePageCascade.
 */
@Injectable()
export class ConfluencePageStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Owner-gated provenance for a set of sources (the catalog + drawer). */
  async forOwnerSources(
    ownerId: string,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<Map<string, ConfluencePageRow>> {
    if (refs.length === 0) return new Map();
    const clauses = refs.map((ref) =>
      and(
        eq(confluencePage.sourceType, ref.sourceType),
        eq(confluencePage.sourceId, ref.sourceId),
      )!,
    );
    const rows = await this.db
      .select()
      .from(confluencePage)
      .where(and(eq(confluencePage.ownerId, ownerId), or(...clauses)!));
    return new Map(rows.map((row) => [`${row.sourceType}:${row.sourceId}`, row]));
  }

  /** The deletion cascade's arm: the row is content-bearing and must not
   * outlive its source. Returns the number of rows erased. */
  async eraseForSource(tx: DbOrTx, sourceType: string, sourceId: string): Promise<number> {
    const removed = await tx
      .delete(confluencePage)
      .where(and(eq(confluencePage.sourceType, sourceType), eq(confluencePage.sourceId, sourceId)))
      .returning({ id: confluencePage.id });
    return removed.length;
  }
}

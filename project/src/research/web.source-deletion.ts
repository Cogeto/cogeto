import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../infrastructure/index';
import type { OwnedSourceRef, SourceCascade, SourceDeletion } from '../memory/index';
import { webPage } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'web' (spec §11.1). Deleting a web
 * source removes the whole retained page: `deleteSource` removes the web_page
 * row (the retained text goes with it) inside the enumeration transaction, and
 * `enumerateCascade` hands the saga the optional raw-HTML object so it lands in
 * the SAME receipt — the memories themselves are enumerated by provenance, as
 * for every source. Never touches memory tables (spec §15 rule 2).
 */
@Injectable()
export class WebSourceDeletion implements SourceDeletion {
  readonly sourceType = 'web' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ ownerId: webPage.ownerId })
      .from(webPage)
      .where(eq(webPage.id, sourceId))
      .for('update');
    return rows[0]?.ownerId ?? null;
  }

  /** The space the page row carries (docs/features/spaces.md): stamps the
   * deletion receipt onto its space's chain. */
  async spaceOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ spaceId: webPage.spaceId })
      .from(webPage)
      .where(eq(webPage.id, sourceId));
    return rows[0]?.spaceId ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.delete(webPage).where(eq(webPage.id, sourceId));
  }

  /** Owner erasure's enumeration (issue #632). A captured page carries the
   * scope it was captured under on its own row. */
  async listForOwner(db: DbOrTx, ownerId: string): Promise<OwnedSourceRef[]> {
    return db
      .select({ sourceId: webPage.id, scope: webPage.scope })
      .from(webPage)
      .where(eq(webPage.ownerId, ownerId))
      .orderBy(asc(webPage.id));
  }

  async enumerateCascade(tx: Tx, sourceId: string): Promise<SourceCascade> {
    const rows = await tx
      .select({ rawObjectKey: webPage.rawObjectKey })
      .from(webPage)
      .where(eq(webPage.id, sourceId));
    const key = rows[0]?.rawObjectKey ?? null;
    return { objectKeys: key ? [key] : [], fileSubSourceKeys: [] };
  }

  /**
   * The integrity sweep's legitimacy probe: an optionally retained raw-HTML
   * object is recorded on web_page — not in file_metadata — so the orphan arm
   * asks here before flagging. Only keys on a LIVE web row are owned.
   */
  async ownsObjectKeys(db: DbOrTx, keys: readonly string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const batch = [...keys];
    const rows = await db
      .select({ rawObjectKey: webPage.rawObjectKey })
      .from(webPage)
      .where(inArray(webPage.rawObjectKey, batch));
    const wanted = new Set(batch);
    return rows
      .map((row) => row.rawObjectKey)
      .filter((key): key is string => key !== null && wanted.has(key));
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { webPage } from './persistence/tables';

/**
 * Ingestion's stage-1 port for source_type 'web'. The
 * extraction input is the retained readable text (already boilerplate-stripped
 * by the fetcher), prefixed with the page title so titled claims extract with
 * their subject. `createdAt` is the FETCH time — relative temporal expressions
 * on a web page resolve against when Cogeto read it, which is exactly the
 * "as of" the provenance promises.
 */
@Injectable()
export class WebSourceReader implements SourceReader {
  readonly sourceType = 'web' as const;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db.select().from(webPage).where(eq(webPage.id, sourceId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    // The focused extraction view wins when present: the
    // chunks most relevant to the run's approved query, ranked at capture
    // time. retained_text remains the full source of record.
    const text = row.extractionText ?? row.retainedText;
    const content = row.title ? `${row.title}\n\n${text}` : text;
    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      content,
      scope: row.scope,
      sensitive: row.sensitive,
      // The capture-time space (docs/features/spaces.md); derived facts
      // inherit it.
      spaceId: row.spaceId,
      // A fetched page is someone else's writing. Its obligations are facts
      // about that page, never commitments the user made.
      authoredByUser: false,
      createdAt: row.fetchedAt,
    };
  }

  /**
   * Admission checkpoint: KEY SHARE serializes against the
   * deletion saga's FOR UPDATE + DELETE on this web_page row — see SourceReader.
   */
  async existsForAdmission(tx: Tx, sourceId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: webPage.id })
      .from(webPage)
      .where(eq(webPage.id, sourceId))
      .for('key share');
    return rows.length > 0;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { webPage } from './persistence/tables';

/**
 * Ingestion's stage-1 port for source_type 'web' (Priority 5 Part A). The
 * extraction input is the retained readable text (already boilerplate-stripped
 * by the fetcher), prefixed with the page title so titled claims extract with
 * their subject. `createdAt` is the FETCH time — relative temporal expressions
 * on a web page resolve against when Cogeto read it, which is exactly the
 * "as of" the provenance promises (decision 0043).
 */
@Injectable()
export class WebSourceReader implements SourceReader {
  readonly sourceType = 'web' as const;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db.select().from(webPage).where(eq(webPage.id, sourceId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const content = row.title ? `${row.title}\n\n${row.retainedText}` : row.retainedText;
    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      content,
      scope: row.scope,
      sensitive: row.sensitive,
      createdAt: row.fetchedAt,
    };
  }

  /**
   * Admission checkpoint (decision 0024): KEY SHARE serializes against the
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

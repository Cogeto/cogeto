import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { isolateEmailContent } from '../ingestion/index';
import { emailMessage } from './persistence/tables';

/**
 * Ingestion's stage-1 port for source_type 'email' (Session O4, decision 0028):
 * the pipeline reads an accepted email through this exactly like a note or file,
 * and the SAME downstream stages run. The extraction input is the NEW content of
 * this message — `isolateEmailContent` unwraps a forwarded original and strips
 * quoted reply history + signatures (thread-aware; avoids re-extracting quoted
 * history that is already its own source). The full bodies remain retained on the
 * row untouched. Never touches memory tables — extraction belongs to ingestion.
 */
@Injectable()
export class EmailSourceReader implements SourceReader {
  readonly sourceType = 'email' as const;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db
      .select()
      .from(emailMessage)
      .where(eq(emailMessage.id, sourceId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const subject = row.subject?.trim();
    const body = isolateEmailContent(row.textBody);
    // Give the extractor the subject as a lead line — email facts often live in
    // the subject ("Deadline moved to Friday"). Falls back to the subject alone
    // when the body is empty (e.g. an HTML-only message with no text part).
    const content = [subject, body].filter(Boolean).join('\n\n') || subject || '';

    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      content,
      // Relative temporal expressions resolve against when the mail was sent.
      createdAt: row.sentAt ?? row.receivedAt,
      scope: row.scope,
      sensitive: row.sensitive,
    };
  }

  /**
   * Admission checkpoint (decision 0024): KEY SHARE serializes against the
   * deletion saga's FOR UPDATE + DELETE of this email row (saga coverage of
   * email sources lands in Unit B; the checkpoint is in place now).
   */
  async existsForAdmission(tx: Tx, sourceId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: emailMessage.id })
      .from(emailMessage)
      .where(eq(emailMessage.id, sourceId))
      .for('key share');
    return rows.length > 0;
  }
}

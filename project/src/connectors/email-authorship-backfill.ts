import { Inject, Injectable } from '@nestjs/common';
import { eq, isNull } from 'drizzle-orm';
import { DRIZZLE, withTransactionalEnqueue } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { UserDirectory } from '../identity/index';
import { MemoryStore } from '../memory/index';
import { isolateEmailContentDetailed } from '../ingestion/index';
import { TASKS_DERIVATION_CLEANUP_JOB_TYPE } from '../tasks/index';
import { normalizeAddress } from './email-parse';
import { emailMessage } from './persistence/tables';

/** The one-shot job migration 0030 enqueues; idempotent by the IS NULL scan. */
export const EMAIL_AUTHORSHIP_BACKFILL_JOB_TYPE = 'email_authorship_backfill';

export interface AuthorshipBackfillReport {
  classified: number;
  authoredByOwner: number;
  memoriesStamped: number;
}

/**
 * Historical email-authorship classification (P6.5; decision 0054 ruling 5):
 * pre-0030 email_message rows carry no routing fact, so this one-shot job
 * re-derives it structurally — authored_by_owner iff the message's own From is
 * the capture user's registered address (SPF cannot be re-checked historically;
 * the from-match is the best available evidence and the decision record states
 * it) — then stamps each email's derived memories with the full authorship
 * verdict (self-authored AND not a forwarded original AND not the
 * quoted-history fallback), exactly as the SourceReader computes it live.
 *
 * When every row is classified it enqueues the tasks derivation cleanup, so
 * the cleanup always classifies email-derived tasks from stamped data. Both
 * jobs are idempotent; re-delivery re-scans nothing (IS NULL) and re-enqueues
 * a cleanup that finds no remaining candidates.
 */
@Injectable()
export class EmailAuthorshipBackfill {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly directory: UserDirectory,
    private readonly memoryStore: MemoryStore,
  ) {}

  async run(log: (message: string) => void = () => undefined): Promise<AuthorshipBackfillReport> {
    const report: AuthorshipBackfillReport = {
      classified: 0,
      authoredByOwner: 0,
      memoriesStamped: 0,
    };
    const rows = await this.db
      .select({
        id: emailMessage.id,
        ownerId: emailMessage.ownerId,
        fromAddr: emailMessage.fromAddr,
        textBody: emailMessage.textBody,
      })
      .from(emailMessage)
      .where(isNull(emailMessage.authoredByOwner));
    const owners = await this.directory.usersByIds([...new Set(rows.map((r) => r.ownerId))]);
    const ownerEmails = new Map(owners.map((u) => [u.userId, normalizeAddress(u.email)]));

    for (const row of rows) {
      const ownerAddr = ownerEmails.get(row.ownerId) ?? null;
      const authoredByOwner = ownerAddr !== null && normalizeAddress(row.fromAddr) === ownerAddr;
      const isolated = isolateEmailContentDetailed(row.textBody);
      const authoredByUser = authoredByOwner && !isolated.forwarded && !isolated.quotedFallback;
      await this.db.transaction(async (tx) => {
        await tx.update(emailMessage).set({ authoredByOwner }).where(eq(emailMessage.id, row.id));
        report.memoriesStamped += await this.memoryStore.setAuthoredByUserBySourceSystem(
          'email',
          row.id,
          authoredByUser,
        );
      });
      report.classified += 1;
      if (authoredByOwner) report.authoredByOwner += 1;
    }

    // Chain to the tasks cleanup — always, so a fresh instance (zero email
    // rows) still runs its (empty) cleanup and prints the count summary.
    await this.db.transaction(async (tx) => {
      await withTransactionalEnqueue(
        tx,
        {
          type: 'email.authorship_backfilled',
          payload: {
            source_type: 'email_authorship_backfill',
            source_id: 'migration-0030',
          },
        },
        {
          type: TASKS_DERIVATION_CLEANUP_JOB_TYPE,
          payload: { source_type: 'tasks', source_id: 'derivation-rule-migration' },
        },
      );
    });
    log(
      `email authorship backfill: ${report.classified} classified ` +
        `(${report.authoredByOwner} authored by owner), ${report.memoriesStamped} memories stamped`,
    );
    return report;
  }
}

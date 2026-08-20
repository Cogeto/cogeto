import { and, asc, desc, eq, gt, ilike, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../infrastructure/index';
import { emailMessage } from './persistence/tables';

/**
 * The email family's contribution to the source catalog (V2.2 item 5.2):
 * plain owner-scoped functions over the family's own table, the
 * `latestGateRefusalFor` shape. The display name is the subject, falling back
 * to the sender when a message has none.
 */

export interface SourceListingRow {
  sourceId: string;
  name: string;
  at: Date;
}

export async function listEmailSources(
  db: DbOrTx,
  ownerId: string,
  options: {
    cursor?: Date;
    order?: 'asc' | 'desc';
    limit?: number;
    q?: string;
    /** The caller's space (docs/features/spaces.md), required (section 6d):
     * one space's listing, never all spaces and never a silent default. */
    spaceId: string;
  },
): Promise<SourceListingRow[]> {
  const clauses: (SQL | undefined)[] = [
    eq(emailMessage.ownerId, ownerId),
    eq(emailMessage.spaceId, options.spaceId),
  ];
  const order = options.order ?? 'desc';
  if (options.cursor) {
    clauses.push(
      order === 'desc'
        ? lt(emailMessage.receivedAt, options.cursor)
        : gt(emailMessage.receivedAt, options.cursor),
    );
  }
  if (options.q?.trim()) clauses.push(ilike(emailMessage.subject, `%${options.q.trim()}%`));
  const rows = await db
    .select({
      id: emailMessage.id,
      subject: emailMessage.subject,
      fromAddr: emailMessage.fromAddr,
      receivedAt: emailMessage.receivedAt,
    })
    .from(emailMessage)
    .where(and(...clauses.filter((c): c is SQL => c !== undefined)))
    .orderBy(
      order === 'desc' ? desc(emailMessage.receivedAt) : asc(emailMessage.receivedAt),
      order === 'desc' ? desc(emailMessage.id) : asc(emailMessage.id),
    )
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map((row) => ({
    sourceId: row.id,
    name: row.subject?.trim() || row.fromAddr,
    at: row.receivedAt,
  }));
}

export async function hydrateEmailSources(
  db: DbOrTx,
  ownerId: string,
  ids: readonly string[],
  spaceId: string,
): Promise<Map<string, SourceListingRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: emailMessage.id,
      subject: emailMessage.subject,
      fromAddr: emailMessage.fromAddr,
      receivedAt: emailMessage.receivedAt,
    })
    .from(emailMessage)
    .where(
      and(
        eq(emailMessage.ownerId, ownerId),
        eq(emailMessage.spaceId, spaceId),
        inArray(emailMessage.id, [...ids]),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.id,
      { sourceId: row.id, name: row.subject?.trim() || row.fromAddr, at: row.receivedAt },
    ]),
  );
}

export async function countEmailSources(
  db: DbOrTx,
  ownerId: string,
  spaceId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessage)
    .where(and(eq(emailMessage.ownerId, ownerId), eq(emailMessage.spaceId, spaceId)));
  return rows[0]?.n ?? 0;
}

import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../infrastructure/index';
import { webPage } from './persistence/tables';

/**
 * The web family's contribution to the source catalog (V2.2 item 5.2):
 * plain owner-scoped functions over the family's own table, the
 * `latestGateRefusalFor` shape. The display name is the page title, falling
 * back to the final URL.
 */

export interface SourceListingRow {
  sourceId: string;
  name: string;
  at: Date;
}

export async function listWebSources(
  db: DbOrTx,
  ownerId: string,
  options: { cursor?: Date; order?: 'asc' | 'desc'; limit?: number; q?: string } = {},
): Promise<SourceListingRow[]> {
  const clauses: (SQL | undefined)[] = [eq(webPage.ownerId, ownerId)];
  const order = options.order ?? 'desc';
  if (options.cursor) {
    clauses.push(
      order === 'desc'
        ? lt(webPage.fetchedAt, options.cursor)
        : gt(webPage.fetchedAt, options.cursor),
    );
  }
  if (options.q?.trim()) {
    const like = `%${options.q.trim()}%`;
    clauses.push(or(ilike(webPage.title, like), ilike(webPage.finalUrl, like)));
  }
  const rows = await db
    .select({
      id: webPage.id,
      title: webPage.title,
      finalUrl: webPage.finalUrl,
      fetchedAt: webPage.fetchedAt,
    })
    .from(webPage)
    .where(and(...clauses.filter((c): c is SQL => c !== undefined)))
    .orderBy(
      order === 'desc' ? desc(webPage.fetchedAt) : asc(webPage.fetchedAt),
      order === 'desc' ? desc(webPage.id) : asc(webPage.id),
    )
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map((row) => ({
    sourceId: row.id,
    name: row.title?.trim() || row.finalUrl,
    at: row.fetchedAt,
  }));
}

export async function hydrateWebSources(
  db: DbOrTx,
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, SourceListingRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: webPage.id,
      title: webPage.title,
      finalUrl: webPage.finalUrl,
      fetchedAt: webPage.fetchedAt,
    })
    .from(webPage)
    .where(and(eq(webPage.ownerId, ownerId), inArray(webPage.id, [...ids])));
  return new Map(
    rows.map((row) => [
      row.id,
      { sourceId: row.id, name: row.title?.trim() || row.finalUrl, at: row.fetchedAt },
    ]),
  );
}

export async function countWebSources(db: DbOrTx, ownerId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webPage)
    .where(eq(webPage.ownerId, ownerId));
  return rows[0]?.n ?? 0;
}

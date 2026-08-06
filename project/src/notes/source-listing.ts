import { and, asc, desc, eq, gt, ilike, inArray, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../infrastructure/index';
import { note } from './persistence/tables';

/**
 * The note family's contribution to the source catalog (V2.2 item 5.2), as
 * plain owner-scoped functions over the family's own table — the
 * `latestGateRefusalFor` shape: the composing surface passes its handle, the
 * table is named only here, and no module import runs against the graph.
 */

export interface SourceListingRow {
  sourceId: string;
  /** The display name: a note's opening line. */
  name: string;
  at: Date;
}

const NAME_CHARS = 96;

const nameOf = (content: string): string =>
  content.replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS);

export async function listNoteSources(
  db: DbOrTx,
  ownerId: string,
  options: { cursor?: Date; order?: 'asc' | 'desc'; limit?: number; q?: string } = {},
): Promise<SourceListingRow[]> {
  const clauses: (SQL | undefined)[] = [eq(note.ownerId, ownerId)];
  const order = options.order ?? 'desc';
  if (options.cursor) {
    clauses.push(
      order === 'desc' ? lt(note.createdAt, options.cursor) : gt(note.createdAt, options.cursor),
    );
  }
  if (options.q?.trim()) clauses.push(ilike(note.content, `%${options.q.trim()}%`));
  const rows = await db
    .select({ id: note.id, content: note.content, createdAt: note.createdAt })
    .from(note)
    .where(and(...clauses.filter((c): c is SQL => c !== undefined)))
    .orderBy(
      order === 'desc' ? desc(note.createdAt) : asc(note.createdAt),
      order === 'desc' ? desc(note.id) : asc(note.id),
    )
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map((row) => ({ sourceId: row.id, name: nameOf(row.content), at: row.createdAt }));
}

export async function hydrateNoteSources(
  db: DbOrTx,
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, SourceListingRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: note.id, content: note.content, createdAt: note.createdAt })
    .from(note)
    .where(and(eq(note.ownerId, ownerId), inArray(note.id, [...ids])));
  return new Map(
    rows.map((row) => [row.id, { sourceId: row.id, name: nameOf(row.content), at: row.createdAt }]),
  );
}

export async function countNoteSources(db: DbOrTx, ownerId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(note)
    .where(eq(note.ownerId, ownerId));
  return rows[0]?.n ?? 0;
}

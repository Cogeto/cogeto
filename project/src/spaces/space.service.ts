import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal, SpaceDto } from '@cogeto/shared';
import { DRIZZLE, untranslatedError, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { space, userSpaceState } from './persistence/tables';
import type { SpaceRow } from './persistence/tables';

/** A space's name is a label a person scans in a switcher, not a document. */
const MAX_NAME_LENGTH = 120;

/**
 * The spaces surface (docs/features/spaces.md), data and API only in this
 * session; the switcher is a later one. Every instance user sees every space
 * (no per-space membership, by owner decision), so `list` takes no owner
 * filter. What a space SEALS is content, and that wall is the gate dimension
 * in the memory module, never anything here.
 *
 * There is deliberately no delete in this session: deleting a space has its
 * own decision-record rules (empty, or the ordinary deletion saga per source)
 * and lands with the surface that can state them honestly.
 */
@Injectable()
export class SpaceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(): Promise<SpaceDto[]> {
    const rows = await this.db.select().from(space).orderBy(asc(space.createdAt), asc(space.id));
    return rows.map(toSpaceDto);
  }

  async create(principal: Principal, rawName: string): Promise<SpaceDto> {
    const name = validName(rawName);
    const [row] = await this.db.insert(space).values({ name }).returning();
    // Ids only in the detail: the name is the user's own words and stays off
    // the org-readable audit trail, like a project's.
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'space.created',
      entityType: 'space',
      entityId: row!.id,
      detail: {},
      ownerId: principal.userId,
      orgId: principal.orgId,
    });
    return toSpaceDto(row!);
  }

  async rename(principal: Principal, id: string, rawName: string): Promise<SpaceDto> {
    const name = validName(rawName);
    const [row] = await this.db.update(space).set({ name }).where(eq(space.id, id)).returning();
    if (!row) throw untranslatedError.notFound(`space ${id} not found`);
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'space.renamed',
      entityType: 'space',
      entityId: id,
      detail: {},
      ownerId: principal.userId,
      orgId: principal.orgId,
    });
    return toSpaceDto(row);
  }

  /**
   * The caller's current space: their last used one while it still exists,
   * else the default space. This is the login-time resolution; per request
   * the space arrives explicitly on the header, and absence means the default
   * space (resolveSpaceId), never this read.
   */
  async currentFor(principal: Principal): Promise<string> {
    const rows = await this.db
      .select({ lastSpaceId: userSpaceState.lastSpaceId })
      .from(userSpaceState)
      .where(eq(userSpaceState.userId, principal.userId))
      .limit(1);
    const last = rows[0]?.lastSpaceId;
    if (!last) return DEFAULT_SPACE_ID;
    const exists = await this.db
      .select({ id: space.id })
      .from(space)
      .where(eq(space.id, last))
      .limit(1);
    return exists[0]?.id ?? DEFAULT_SPACE_ID;
  }

  /** Persists the last used space. The id must name a real space: an unknown
   * one is refused loudly rather than stored as a dangling pointer. */
  async setCurrent(principal: Principal, spaceId: string): Promise<string> {
    const exists = await this.db
      .select({ id: space.id })
      .from(space)
      .where(eq(space.id, spaceId))
      .limit(1);
    if (!exists[0]) throw untranslatedError.notFound(`space ${spaceId} not found`);
    await this.db
      .insert(userSpaceState)
      .values({ userId: principal.userId, lastSpaceId: spaceId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userSpaceState.userId,
        set: { lastSpaceId: spaceId, updatedAt: new Date() },
      });
    return spaceId;
  }
}

function validName(raw: string): string {
  const name = raw.trim();
  if (!name) throw untranslatedError.badRequest('a space needs a name');
  if (name.length > MAX_NAME_LENGTH) {
    throw untranslatedError.badRequest(`a space name is at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function toSpaceDto(row: SpaceRow): SpaceDto {
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
}

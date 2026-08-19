import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db } from '../../infrastructure/index';
import { EntityAliasIndex } from '../domain/entity-match';
import { entityAlias } from './tables';
import type { EntityAliasRow } from './tables';

/**
 * The owner's recorded entity aliases (V2.3 item 6.1, issue A): the data half
 * of alias-aware pairing. Reads build the pure EntityAliasIndex the candidate
 * rules consume; writes are owner-only through the reconcile-aliases API.
 * Duplicate pairs are refused by the unique (owner, space, lower(canonical),
 * lower(alias)) index and surface as a no-op, not an error.
 *
 * Aliases are space-scoped (docs/features/spaces.md): the vocabulary is
 * sealed with the corpus it describes, so every read and write is keyed by
 * (owner, space). The parameter defaults to the default space so a caller
 * that predates spaces reads exactly what it always read.
 */
@Injectable()
export class EntityAliasStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listForOwner(
    ownerId: string,
    spaceId: string = DEFAULT_SPACE_ID,
  ): Promise<EntityAliasRow[]> {
    return this.db
      .select()
      .from(entityAlias)
      .where(and(eq(entityAlias.ownerId, ownerId), eq(entityAlias.spaceId, spaceId)))
      .orderBy(asc(entityAlias.createdAt), asc(entityAlias.id));
  }

  /** The alias index for one owner in one space — what reconciliation loads
   * per batch. */
  async indexForOwner(
    ownerId: string,
    spaceId: string = DEFAULT_SPACE_ID,
  ): Promise<EntityAliasIndex> {
    const rows = await this.listForOwner(ownerId, spaceId);
    return new EntityAliasIndex(rows);
  }

  async add(
    ownerId: string,
    canonical: string,
    alias: string,
    spaceId: string = DEFAULT_SPACE_ID,
  ): Promise<EntityAliasRow | null> {
    const rows = await this.db
      .insert(entityAlias)
      .values({ ownerId, spaceId, canonical: canonical.trim(), alias: alias.trim() })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /** Owner-gated delete; false when the row is not theirs or already gone.
   * The id is globally unique, so no space filter is needed and a row is
   * removable from wherever its owner manages it. */
  async remove(ownerId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(entityAlias)
      .where(and(eq(entityAlias.id, id), eq(entityAlias.ownerId, ownerId)))
      .returning({ id: entityAlias.id });
    return rows.length > 0;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db } from '../../infrastructure/index';
import { EntityAliasIndex } from '../domain/entity-match';
import { entityAlias } from './tables';
import type { EntityAliasRow } from './tables';

/**
 * The owner's recorded entity aliases (V2.3 item 6.1, issue A): the data half
 * of alias-aware pairing. Reads build the pure EntityAliasIndex the candidate
 * rules consume; writes are owner-only through the reconcile-aliases API.
 * Duplicate pairs are refused by the unique (owner, lower(canonical),
 * lower(alias)) index and surface as a no-op, not an error.
 */
@Injectable()
export class EntityAliasStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listForOwner(ownerId: string): Promise<EntityAliasRow[]> {
    return this.db
      .select()
      .from(entityAlias)
      .where(eq(entityAlias.ownerId, ownerId))
      .orderBy(asc(entityAlias.createdAt), asc(entityAlias.id));
  }

  /** The alias index for one owner — what reconciliation loads per batch. */
  async indexForOwner(ownerId: string): Promise<EntityAliasIndex> {
    const rows = await this.listForOwner(ownerId);
    return new EntityAliasIndex(rows);
  }

  async add(ownerId: string, canonical: string, alias: string): Promise<EntityAliasRow | null> {
    const rows = await this.db
      .insert(entityAlias)
      .values({ ownerId, canonical: canonical.trim(), alias: alias.trim() })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /** Owner-gated delete; false when the row is not theirs or already gone. */
  async remove(ownerId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(entityAlias)
      .where(and(eq(entityAlias.id, id), eq(entityAlias.ownerId, ownerId)))
      .returning({ id: entityAlias.id });
    return rows.length > 0;
  }
}

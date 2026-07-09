import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { appUser } from './persistence/tables';

/**
 * The user directory (O2-B) — the identity seam's local name book. Records each
 * Principal on authentication so shared-memory surfaces can name an owner
 * without a per-owner Zitadel call. Reads are name-only; the directory never
 * grants visibility — the memory gates alone decide what a caller sees.
 */
@Injectable()
export class UserDirectory {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Upsert on login/refresh — "provision the Principal", keep the name fresh. */
  async record(principal: Principal): Promise<void> {
    if (!principal.userId) return;
    await this.db
      .insert(appUser)
      .values({
        userId: principal.userId,
        orgId: principal.orgId,
        displayName: principal.name || principal.userId,
        email: principal.email,
        lastSeen: new Date(),
      })
      .onConflictDoUpdate({
        target: appUser.userId,
        set: {
          orgId: principal.orgId,
          displayName: principal.name || principal.userId,
          email: principal.email,
          lastSeen: new Date(),
        },
      });
  }

  /** Owner-id → display name for the ids that are known; unknown ids are absent. */
  async displayNames(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ userId: appUser.userId, displayName: appUser.displayName })
      .from(appUser)
      .where(inArray(appUser.userId, unique));
    return new Map(rows.map((r) => [r.userId, r.displayName]));
  }
}

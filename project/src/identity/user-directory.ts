import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
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
  /** userId → orgId, memoized: org membership is deployment-stable (0019). */
  private readonly orgCache = new Map<string, string>();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The org a user belongs to, or null when the directory has never seen them
   * (QS-13, decision 0025): how system-actor audit writers (reconciliation,
   * task derivation, staleness transitions) stamp org_id on entries that have
   * an owner but no Principal in scope. Name-book semantics apply: this never
   * grants visibility, it only labels the trail.
   */
  async orgOf(userId: string): Promise<string | null> {
    if (!userId) return null;
    const cached = this.orgCache.get(userId);
    if (cached !== undefined) return cached;
    const rows = await this.db
      .select({ orgId: appUser.orgId })
      .from(appUser)
      .where(eq(appUser.userId, userId))
      .limit(1);
    const orgId = rows[0]?.orgId ?? null;
    // Cache hits only — an unknown user may log in later and become known.
    if (orgId !== null) this.orgCache.set(userId, orgId);
    return orgId;
  }

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

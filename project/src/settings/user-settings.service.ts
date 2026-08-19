import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Principal, UpdateUserSettingsRequest, UserSettingsDto } from '@cogeto/shared';
import { resolveSpaceId } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { userSettings } from './persistence/tables';

/**
 * Per-user, per-space capture/upload defaults (Settings; the space dimension
 * is the settings split, docs/features/spaces.md section 4). One row per
 * (user, space), created on first write — a read with no row returns the
 * column defaults, so a new space begins with sensible defaults rather than
 * empty ones. Every update is audited (org-scoped, stamped with its space),
 * so the trust surface shows preference changes.
 */
@Injectable()
export class UserSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(principal: Principal): Promise<UserSettingsDto> {
    const rows = await this.db
      .select()
      .from(userSettings)
      .where(
        and(
          eq(userSettings.userId, principal.userId),
          eq(userSettings.spaceId, resolveSpaceId(principal)),
        ),
      )
      .limit(1);
    const row = rows[0];
    return {
      discardByDefault: row?.discardByDefault ?? false,
      defaultScope: row?.defaultScope ?? 'private',
      autoResearch: row?.autoResearch ?? false,
    };
  }

  /**
   * The default capture scope for one user by id in one space (no Principal
   * available in the email intake or the chat capture worker, which act for
   * the resolved recipient/owner). The space is REQUIRED so no caller can
   * silently read across the wall: a worker passes its subject row's space,
   * the email intake passes the default space it captures into.
   * No row → the column default, private.
   */
  async defaultScopeFor(userId: string, spaceId: string): Promise<'private' | 'shared'> {
    const rows = await this.db
      .select({ defaultScope: userSettings.defaultScope })
      .from(userSettings)
      .where(and(eq(userSettings.userId, userId), eq(userSettings.spaceId, spaceId)))
      .limit(1);
    return rows[0]?.defaultScope ?? 'private';
  }

  async update(principal: Principal, patch: UpdateUserSettingsRequest): Promise<UserSettingsDto> {
    const spaceId = resolveSpaceId(principal);
    const current = await this.get(principal);
    const next: UserSettingsDto = {
      discardByDefault: patch.discardByDefault ?? current.discardByDefault,
      defaultScope: patch.defaultScope ?? current.defaultScope,
      autoResearch: patch.autoResearch ?? current.autoResearch,
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(userSettings)
        .values({
          userId: principal.userId,
          spaceId,
          orgId: principal.orgId,
          discardByDefault: next.discardByDefault,
          defaultScope: next.defaultScope,
          autoResearch: next.autoResearch,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [userSettings.userId, userSettings.spaceId],
          set: {
            discardByDefault: next.discardByDefault,
            defaultScope: next.defaultScope,
            autoResearch: next.autoResearch,
            updatedAt: new Date(),
          },
        });
      await writeAudit(tx, {
        actor: `user:${principal.userId}`,
        action: 'settings.updated',
        entityType: 'user_settings',
        entityId: principal.userId,
        detail: { ...next },
        orgId: principal.orgId,
        ownerId: principal.userId,
        spaceId,
      });
    });
    return next;
  }
}

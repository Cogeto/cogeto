import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Principal, UpdateUserSettingsRequest, UserSettingsDto } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { userSettings } from './persistence/tables';

/**
 * Per-user capture/upload defaults (§A.9; O1-C Settings). One row per user,
 * created on first write — a read with no row returns the column defaults. Every
 * update is audited (org-scoped), so the trust surface shows preference changes.
 */
@Injectable()
export class UserSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(principal: Principal): Promise<UserSettingsDto> {
    const rows = await this.db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, principal.userId))
      .limit(1);
    const row = rows[0];
    return {
      discardByDefault: row?.discardByDefault ?? false,
      defaultScope: row?.defaultScope ?? 'private',
    };
  }

  async update(principal: Principal, patch: UpdateUserSettingsRequest): Promise<UserSettingsDto> {
    const current = await this.get(principal);
    const next: UserSettingsDto = {
      discardByDefault: patch.discardByDefault ?? current.discardByDefault,
      defaultScope: patch.defaultScope ?? current.defaultScope,
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(userSettings)
        .values({
          userId: principal.userId,
          orgId: principal.orgId,
          discardByDefault: next.discardByDefault,
          defaultScope: next.defaultScope,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            discardByDefault: next.discardByDefault,
            defaultScope: next.defaultScope,
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
      });
    });
    return next;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type {
  PreferredLanguage,
  SuggestibleContextField,
  UpdateUserContextRequest,
} from '@cogeto/shared';
import { SUPPORTED_LANGUAGES } from '@cogeto/shared';
import { writeAudit } from './audit';
import { DRIZZLE } from './db';
import type { Db, DbOrTx } from './db';
import { contextSuggestionDismissal, userContext } from './persistence/tables';

/**
 * Per-user instance context (P6.6, decisions 0051/0052/0053): who the user is,
 * which timezone their "today" lives in, and which language Cogeto speaks.
 * Lives in infrastructure because the context feeds prompts and copy in
 * retrieval, connectors, ingestion and tasks alike — no domain module owns it.
 *
 * The values here are settings, not memories: they shape phrasing and
 * interpretation but are never citable facts (decision 0051). Audit entries
 * record WHICH fields changed (structural), never the profile text itself.
 */

export interface UserContextRecord {
  displayName: string | null;
  company: string | null;
  roleTitle: string | null;
  aboutWork: string | null;
  /** Per-user IANA zone override; null = the instance timezone applies. */
  timezone: string | null;
  preferredLanguage: PreferredLanguage;
  languageStrict: boolean;
  companySourceMemoryId: string | null;
  roleTitleSourceMemoryId: string | null;
}

/** The defaults for a user with no row: everything unset, English, mirroring. */
export const EMPTY_USER_CONTEXT: UserContextRecord = {
  displayName: null,
  company: null,
  roleTitle: null,
  aboutWork: null,
  timezone: null,
  preferredLanguage: 'en',
  languageStrict: false,
  companySourceMemoryId: null,
  roleTitleSourceMemoryId: null,
};

function asLanguage(value: string | null | undefined): PreferredLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value ?? '')
    ? (value as PreferredLanguage)
    : 'en';
}

const FIELD_COLUMNS = {
  company: { value: 'company', source: 'companySourceMemoryId' },
  roleTitle: { value: 'roleTitle', source: 'roleTitleSourceMemoryId' },
} as const;

@Injectable()
export class UserContextService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** No row → the defaults (everything unset, English, mirroring on). */
  async get(userId: string): Promise<UserContextRecord> {
    const rows = await this.db
      .select()
      .from(userContext)
      .where(eq(userContext.userId, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return { ...EMPTY_USER_CONTEXT };
    return {
      displayName: row.displayName,
      company: row.company,
      roleTitle: row.roleTitle,
      aboutWork: row.aboutWork,
      timezone: row.timezone,
      preferredLanguage: asLanguage(row.preferredLanguage),
      languageStrict: row.languageStrict,
      companySourceMemoryId: row.companySourceMemoryId,
      roleTitleSourceMemoryId: row.roleTitleSourceMemoryId,
    };
  }

  /** The preferred language for one user by id (system-initiated paths). */
  async preferredLanguageFor(userId: string): Promise<PreferredLanguage> {
    const rows = await this.db
      .select({ preferredLanguage: userContext.preferredLanguage })
      .from(userContext)
      .where(eq(userContext.userId, userId))
      .limit(1);
    return asLanguage(rows[0]?.preferredLanguage);
  }

  /**
   * Partial update; explicit null clears a field. A user-typed company or role
   * clears that field's suggestion provenance — the value is theirs now.
   */
  async update(
    who: { userId: string; orgId: string },
    patch: UpdateUserContextRequest,
  ): Promise<UserContextRecord> {
    const current = await this.get(who.userId);
    const next: UserContextRecord = {
      ...current,
      displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
      company: patch.company !== undefined ? patch.company : current.company,
      roleTitle: patch.roleTitle !== undefined ? patch.roleTitle : current.roleTitle,
      aboutWork: patch.aboutWork !== undefined ? patch.aboutWork : current.aboutWork,
      timezone: patch.timezone !== undefined ? patch.timezone : current.timezone,
      preferredLanguage: patch.preferredLanguage ?? current.preferredLanguage,
      languageStrict: patch.languageStrict ?? current.languageStrict,
      companySourceMemoryId: patch.company !== undefined ? null : current.companySourceMemoryId,
      roleTitleSourceMemoryId:
        patch.roleTitle !== undefined ? null : current.roleTitleSourceMemoryId,
    };
    await this.db.transaction(async (tx) => {
      await this.upsert(tx, who, next);
      await writeAudit(tx, {
        actor: `user:${who.userId}`,
        action: 'context.updated',
        entityType: 'user_context',
        entityId: who.userId,
        // Structural only: which fields changed + the config-valued settings.
        detail: {
          fields: Object.keys(patch),
          preferredLanguage: next.preferredLanguage,
          languageStrict: next.languageStrict,
          timezone: next.timezone,
        },
        orgId: who.orgId,
        ownerId: who.userId,
      });
    });
    return next;
  }

  /**
   * Accept a derived suggestion (decision 0053): sets the field with its
   * provenance memory recorded, audited with the memory id (a structural id).
   */
  async applySuggestion(
    who: { userId: string; orgId: string },
    field: SuggestibleContextField,
    value: string,
    sourceMemoryId: string,
  ): Promise<UserContextRecord> {
    const current = await this.get(who.userId);
    const columns = FIELD_COLUMNS[field];
    const next: UserContextRecord = {
      ...current,
      [columns.value]: value,
      [columns.source]: sourceMemoryId,
    };
    await this.db.transaction(async (tx) => {
      await this.upsert(tx, who, next);
      await writeAudit(tx, {
        actor: `user:${who.userId}`,
        action: 'context.suggestion_accepted',
        entityType: 'user_context',
        entityId: who.userId,
        detail: { field, derivedFromMemoryId: sourceMemoryId },
        orgId: who.orgId,
        ownerId: who.userId,
      });
    });
    return next;
  }

  /** A dismissed (field, value) pair is remembered and never re-proposed. */
  async dismissSuggestion(
    who: { userId: string; orgId: string },
    field: SuggestibleContextField,
    value: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(contextSuggestionDismissal)
        .values({ userId: who.userId, field, value: normalizeValue(value) })
        .onConflictDoNothing();
      await writeAudit(tx, {
        actor: `user:${who.userId}`,
        action: 'context.suggestion_dismissed',
        entityType: 'user_context',
        entityId: who.userId,
        detail: { field },
        orgId: who.orgId,
        ownerId: who.userId,
      });
    });
  }

  async dismissedValues(userId: string, field: SuggestibleContextField): Promise<string[]> {
    const rows = await this.db
      .select({ value: contextSuggestionDismissal.value })
      .from(contextSuggestionDismissal)
      .where(
        and(
          eq(contextSuggestionDismissal.userId, userId),
          eq(contextSuggestionDismissal.field, field),
        ),
      );
    return rows.map((r) => r.value);
  }

  private async upsert(
    tx: DbOrTx,
    who: { userId: string; orgId: string },
    next: UserContextRecord,
  ): Promise<void> {
    const values = {
      userId: who.userId,
      orgId: who.orgId,
      displayName: next.displayName,
      company: next.company,
      roleTitle: next.roleTitle,
      aboutWork: next.aboutWork,
      timezone: next.timezone,
      preferredLanguage: next.preferredLanguage,
      languageStrict: next.languageStrict,
      companySourceMemoryId: next.companySourceMemoryId,
      roleTitleSourceMemoryId: next.roleTitleSourceMemoryId,
      updatedAt: new Date(),
    };
    await tx.insert(userContext).values(values).onConflictDoUpdate({
      target: userContext.userId,
      set: values,
    });
  }
}

/** Dismissals compare on the trimmed value, case-insensitively. */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

/** True when any profile field is set — the USER CONTEXT block will render. */
export function hasProfileContext(record: UserContextRecord): boolean {
  return Boolean(record.displayName || record.company || record.roleTitle || record.aboutWork);
}

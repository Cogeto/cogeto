import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The user directory (migration 0019), identity-owned and module-private. One
 * row per authenticated user, recorded on first login and refreshed on each
 * fresh token resolve. Its only job is to name the OWNER of a shared memory a
 * peer can see (O2-B) — resolved through the identity seam, never by reading
 * this table from another module.
 */
export const appUser = pgTable(
  'app_user',
  {
    userId: text('user_id').primaryKey(),
    orgId: text('org_id').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('app_user_org_idx').on(t.orgId)],
);

export type AppUserRow = typeof appUser.$inferSelect;

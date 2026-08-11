import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The user directory (migration 0019), identity-owned and module-private. One
 * row per authenticated user, recorded on first login and refreshed on each
 * fresh token resolve. Its only job is to name the OWNER of a shared memory a
 * peer can see — resolved through the identity seam, never by reading
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

/**
 * Connector credential material (V2.5 item 8.1, migration 0054), sealed under
 * the instance master key. The plan places credential storage inside the
 * identity seam; this table is why. The `secret` column holds the whole
 * material envelope (access token, refresh token, provider extras) as one
 * sealed value, and it is selected in exactly one function
 * (`connector-credential-store.ts`), asserted structurally by
 * `credential-confinement.spec.ts`. Everything beside it is what the user is
 * entitled to see: expiry, scopes granted, the account the credential
 * belongs to. `connector_id` is a provenance-style reference, not a foreign
 * key: `connector` is another module's table.
 */
export const connectorCredential = pgTable(
  'connector_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    orgId: text('org_id').notNull(),
    connectorId: uuid('connector_id').notNull(),
    /** Sealed material: v1.<iv>.<tag>.<ciphertext> under COGETO_MASTER_KEY. */
    secret: text('secret').notNull(),
    accountIdentity: text('account_identity'),
    scopes: jsonb('scopes').$type<string[]>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    refreshFailedAt: timestamp('refresh_failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connector_credential_connector_idx').on(t.connectorId),
    index('connector_credential_expiry_idx').on(t.expiresAt),
  ],
);

export type ConnectorCredentialRow = typeof connectorCredential.$inferSelect;

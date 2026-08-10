import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tables owned by the providers module (migration 0052, V2.4 item 7.1).
 * Module-private: nothing outside this directory may name them.
 */

/**
 * One endpoint an admin created. `apiKeySecret` is ciphertext under the
 * instance master key and is the one column in this repository that must never
 * leave the module: it is selected only by the decrypting resolver, never by a
 * read that builds a DTO.
 */
export const modelProvider = pgTable('model_provider', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  type: text('type').notNull(),
  baseUrl: text('base_url'),
  apiKeySecret: text('api_key_secret'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ModelProviderRow = typeof modelProvider.$inferSelect;

/** One row per assigned tier; a missing `vision` row means no vision binding. */
export const modelAssignment = pgTable('model_assignment', {
  tier: text('tier').primaryKey(),
  providerId: uuid('provider_id').notNull(),
  model: text('model').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export type ModelAssignmentRow = typeof modelAssignment.$inferSelect;

/** An answer model an admin enabled for users to pick between. */
export const modelAnswerOption = pgTable(
  'model_answer_option',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id').notNull(),
    model: text('model').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('model_answer_option_provider_model_key').on(table.providerId, table.model),
  ],
);

export type ModelAnswerOptionRow = typeof modelAnswerOption.$inferSelect;

/** A user's own answer-model choice. The `user_settings` shape. */
export const userAnswerModel = pgTable('user_answer_model', {
  userId: text('user_id').primaryKey(),
  orgId: text('org_id').notNull(),
  optionId: uuid('option_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserAnswerModelRow = typeof userAnswerModel.$inferSelect;

/** Append-only: every assignment change, with the configuration id it produced. */
export const modelConfigurationChange = pgTable(
  'model_configuration_change',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    configurationId: text('configuration_id').notNull(),
    previousConfigurationId: text('previous_configuration_id'),
    tier: text('tier').notNull(),
    providerLabel: text('provider_label').notNull(),
    model: text('model').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    changedBy: text('changed_by'),
  },
  (table) => [index('model_configuration_change_at_idx').on(table.changedAt)],
);

export type ModelConfigurationChangeRow = typeof modelConfigurationChange.$inferSelect;

/**
 * The single-row marker. `seededAt` is what makes seeding happen exactly once;
 * `version` is what lets a process with no request to react to (the worker)
 * notice a change within one poll.
 */
export const modelConfigState = pgTable('model_config_state', {
  singleton: boolean('singleton').primaryKey().default(true),
  seededAt: timestamp('seeded_at', { withTimezone: true }),
  seedSource: text('seed_source'),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

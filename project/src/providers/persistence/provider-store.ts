import { asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../infrastructure/index';
import {
  modelAnswerOption,
  modelAssignment,
  modelConfigState,
  modelConfigurationChange,
  modelProvider,
  userAnswerModel,
} from './tables';
import type {
  ModelAnswerOptionRow,
  ModelAssignmentRow,
  ModelConfigurationChangeRow,
  ModelProviderRow,
} from './tables';

/**
 * Every read and write of the providers module's six tables (V2.4 item 7.1).
 *
 * One rule shapes this file: **the sealed key column is selected in exactly one
 * place**, {@link ProviderStore.listProvidersWithSecrets}, which exists to feed
 * the resolver that builds the gateway's endpoints. Every other read names its
 * columns explicitly and omits it, so no DTO, log line, error or export can
 * ever carry key material by accident — not because a caller remembered to
 * strip it, but because it was never in the row.
 */

/** A provider row as everything except the resolver sees it: no key material. */
export interface ProviderRecord {
  id: string;
  label: string;
  type: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  createdAt: Date;
}

/** The resolver's view: the same row, plus the sealed key it must open. */
export interface ProviderRecordWithSecret extends ProviderRecord {
  apiKeySecret: string | null;
}

const PUBLIC_COLUMNS = {
  id: modelProvider.id,
  label: modelProvider.label,
  type: modelProvider.type,
  baseUrl: modelProvider.baseUrl,
  // A boolean computed in SQL: the ciphertext never crosses the wire at all.
  hasApiKey: sql<boolean>`${modelProvider.apiKeySecret} is not null`,
  createdAt: modelProvider.createdAt,
};

export class ProviderStore {
  // DbOrTx: the managed rebuild's switch flips the assignment INSIDE its own
  // transaction (through the port), so the store must run against a Tx too.
  constructor(private readonly db: DbOrTx) {}

  /** Every provider, oldest first. Never carries key material. */
  async listProviders(): Promise<ProviderRecord[]> {
    return this.db.select(PUBLIC_COLUMNS).from(modelProvider).orderBy(asc(modelProvider.createdAt));
  }

  async findProvider(id: string): Promise<ProviderRecord | null> {
    const rows = await this.db
      .select(PUBLIC_COLUMNS)
      .from(modelProvider)
      .where(eq(modelProvider.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findProviderByLabel(label: string): Promise<ProviderRecord | null> {
    const rows = await this.db
      .select(PUBLIC_COLUMNS)
      .from(modelProvider)
      .where(eq(modelProvider.label, label))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The ONE read that selects the sealed key column. Called by the resolver
   * that builds the gateway's endpoints, and by nothing else — a call site
   * anywhere but there is a defect, and `provider_key_never_leaves` asserts it.
   */
  async listProvidersWithSecrets(): Promise<ProviderRecordWithSecret[]> {
    const rows = await this.db
      .select({ ...PUBLIC_COLUMNS, apiKeySecret: modelProvider.apiKeySecret })
      .from(modelProvider);
    return rows;
  }

  async createProvider(input: {
    label: string;
    type: string;
    baseUrl: string | null;
    apiKeySecret: string | null;
  }): Promise<ProviderRecord> {
    const rows = await this.db.insert(modelProvider).values(input).returning(PUBLIC_COLUMNS);
    return rows[0]!;
  }

  /** `apiKeySecret: undefined` leaves the stored key untouched; null clears it. */
  async updateProvider(
    id: string,
    patch: { label?: string; baseUrl?: string | null; apiKeySecret?: string | null },
  ): Promise<ProviderRecord | null> {
    const rows = await this.db
      .update(modelProvider)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(modelProvider.id, id))
      .returning(PUBLIC_COLUMNS);
    return rows[0] ?? null;
  }

  async deleteProvider(id: string): Promise<void> {
    await this.db.delete(modelProvider).where(eq(modelProvider.id, id));
  }

  async listAssignments(): Promise<ModelAssignmentRow[]> {
    return this.db.select().from(modelAssignment);
  }

  async putAssignment(input: {
    tier: string;
    providerId: string;
    model: string;
    updatedBy: string | null;
  }): Promise<void> {
    await this.db
      .insert(modelAssignment)
      .values({ ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: modelAssignment.tier,
        set: {
          providerId: input.providerId,
          model: input.model,
          updatedAt: new Date(),
          updatedBy: input.updatedBy,
        },
      });
  }

  async clearAssignment(tier: string): Promise<void> {
    await this.db.delete(modelAssignment).where(eq(modelAssignment.tier, tier));
  }

  async listAnswerOptions(): Promise<ModelAnswerOptionRow[]> {
    return this.db.select().from(modelAnswerOption).orderBy(asc(modelAnswerOption.createdAt));
  }

  async addAnswerOption(input: {
    providerId: string;
    model: string;
    label: string;
  }): Promise<ModelAnswerOptionRow> {
    const rows = await this.db
      .insert(modelAnswerOption)
      .values(input)
      .onConflictDoUpdate({
        target: [modelAnswerOption.providerId, modelAnswerOption.model],
        set: { label: input.label },
      })
      .returning();
    return rows[0]!;
  }

  async removeAnswerOption(id: string): Promise<void> {
    await this.db.delete(modelAnswerOption).where(eq(modelAnswerOption.id, id));
  }

  async answerOptionFor(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ optionId: userAnswerModel.optionId })
      .from(userAnswerModel)
      .where(eq(userAnswerModel.userId, userId))
      .limit(1);
    return rows[0]?.optionId ?? null;
  }

  async setAnswerOptionFor(userId: string, orgId: string, optionId: string): Promise<void> {
    await this.db
      .insert(userAnswerModel)
      .values({ userId, orgId, optionId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userAnswerModel.userId,
        set: { optionId, orgId, updatedAt: new Date() },
      });
  }

  async clearAnswerOptionFor(userId: string): Promise<void> {
    await this.db.delete(userAnswerModel).where(eq(userAnswerModel.userId, userId));
  }

  async recordChange(input: {
    configurationId: string;
    previousConfigurationId: string | null;
    tier: string;
    providerLabel: string;
    model: string;
    changedBy: string | null;
  }): Promise<void> {
    await this.db.insert(modelConfigurationChange).values(input);
  }

  async recentChanges(limit: number): Promise<ModelConfigurationChangeRow[]> {
    return this.db
      .select()
      .from(modelConfigurationChange)
      .orderBy(desc(modelConfigurationChange.changedAt))
      .limit(limit);
  }

  async readState(): Promise<{
    seededAt: Date | null;
    seedSource: string | null;
    version: number;
  }> {
    const rows = await this.db
      .select({
        seededAt: modelConfigState.seededAt,
        seedSource: modelConfigState.seedSource,
        version: modelConfigState.version,
      })
      .from(modelConfigState)
      .limit(1);
    return rows[0] ?? { seededAt: null, seedSource: null, version: 0 };
  }

  /** The version alone — the worker's poll, one column, no join. */
  async readVersion(): Promise<number> {
    const rows = await this.db.select({ version: modelConfigState.version }).from(modelConfigState);
    return rows[0]?.version ?? 0;
  }

  async markSeeded(source: string): Promise<void> {
    await this.db
      .update(modelConfigState)
      .set({ seededAt: new Date(), seedSource: source, updatedAt: new Date() });
  }

  /** Bump the version so every process notices, at most one poll later. */
  async bumpVersion(): Promise<void> {
    await this.db
      .update(modelConfigState)
      .set({ version: sql`${modelConfigState.version} + 1`, updatedAt: new Date() });
  }

  /**
   * Claim the right to seed, atomically. The UPDATE only matches while
   * `seeded_at` is still null, so of two processes starting together exactly
   * one gets a row back and the other finds the seeding already done.
   */
  async claimSeed(source: string): Promise<boolean> {
    const rows = await this.db
      .update(modelConfigState)
      .set({ seededAt: new Date(), seedSource: source, updatedAt: new Date() })
      .where(sql`${modelConfigState.seededAt} is null`)
      .returning({ singleton: modelConfigState.singleton });
    return rows.length > 0;
  }

  /** Undo a claim that could not be completed, so the next start retries it. */
  async releaseSeed(): Promise<void> {
    await this.db
      .update(modelConfigState)
      .set({ seededAt: null, seedSource: null, updatedAt: new Date() });
  }
}

export type { ModelProviderRow };

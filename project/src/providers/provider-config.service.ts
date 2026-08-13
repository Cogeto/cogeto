import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DRIZZLE, openSecret, sealSecret, writeAudit } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import {
  deriveProvidersId,
  embeddingRunConfiguration,
  listProviderModels,
  probeProviderModel,
} from '../model-gateway/index';
import type {
  ProbeTarget,
  ProbeTier,
  ProviderProbeResult,
  ResolvedModelProviders,
} from '../model-gateway/index';
import { EmbeddingRebuildConflictError, EmbeddingRebuildService } from '../memory/index';
import type { EmbeddingSwitchPort } from '../memory/index';
import { ProviderStore } from './persistence/provider-store';
import type { ProviderRecord } from './persistence/provider-store';
import {
  adapterBaseUrl,
  isCreatableProviderType,
  NO_AUTH_PLACEHOLDER,
  PROVIDER_TYPE_SPECS,
} from './domain/provider-types';
import { resolveFromRecords } from './domain/resolve';
import { summariseTrustFor } from './domain/trust-lookup';
import { PROVIDERS_OPTIONS } from './providers.options';
import type { ProvidersOptions } from './providers.options';
import type {
  AnswerModelOptionDto,
  ConfigurationChangeDto,
  CreateProviderRequest,
  EmbeddingRebuildPlanDto,
  EmbeddingRebuildRequest,
  EmbeddingRebuildStatusDto,
  ModelConfigurationDto,
  ModelTierName,
  Principal,
  ProviderAssignmentDto,
  ProviderDto,
  ProviderModelsDto,
  ProviderProbeDto,
  StoredProviderType,
  UpdateProviderRequest,
  UserAnswerModelDto,
} from '@cogeto/shared';

/**
 * The provider and assignment model (V2.4 item 7.1).
 *
 * Three properties hold everywhere in this file, and each of them is the reason
 * for code that would otherwise look redundant:
 *
 * 1. **A saved key never comes back out.** It is written once, sealed, and read
 *    only by {@link resolveFromRecords} at the moment a call is made. Every DTO
 *    here is assembled field by field from a row that does not contain it.
 * 2. **A model is validated by USE, never by its name.** Every assignment is
 *    probed against the tier's actual job before it is stored, because "embed"
 *    in a model name is a naming convention and a multimodal projector is a
 *    runtime fact.
 * 3. **The embeddings tier changes only through the managed rebuild.** A
 *    direct assignment would serve a mixed embedding space, which is exactly
 *    the failure the boot guard exists to prevent, so `assignTier` still
 *    refuses it; the plan/confirm/rebuild flow below re-embeds the whole
 *    corpus into a new collection and switches atomically at completion
 *    (V2.4 item 7.1 second half; the engine is memory's).
 */

/** The operator command that rebuilds the index today, named in the refusal. */
export const REINDEX_COMMAND = 'docker compose exec worker npm run reindex';

/** How many configuration changes the assignment page shows. */
const HISTORY_LIMIT = 20;

@Injectable()
export class ProviderConfigService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProviderConfigService.name);
  private readonly store: ProviderStore;
  /** Last probe outcome per provider id, so the list shows live health without
   * re-probing every endpoint on every render. */
  private readonly health = new Map<
    string,
    { state: ProviderDto['health']['state']; detail: string | null; checkedAt: Date }
  >();
  private poller?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(PROVIDERS_OPTIONS) private readonly options: ProvidersOptions,
    // The managed rebuild (V2.4 item 7.1 second half): memory's engine,
    // resolved when the root threads its memory module instance into this
    // module's imports. Optional so the worker root and bare harnesses keep
    // registering providers alone; the embeddings tier then reports itself
    // locked with the operator command instead.
    @Optional() private readonly embeddingRebuild?: EmbeddingRebuildService,
  ) {
    this.store = new ProviderStore(db);
  }

  /**
   * The watch STARTS ITSELF at bootstrap (issue #494). `startWatching` existed
   * with both roots passing the interval, but nothing ever called it: the app
   * masked the gap by reloading on its own saves, while the worker kept
   * extracting and reading pages with the models it resolved at boot until it
   * happened to restart. A lifecycle hook on the service that owns the poller
   * is the one place no root can forget.
   */
  onApplicationBootstrap(): void {
    this.startWatching(this.options.pollIntervalMs);
  }

  /**
   * Watch for a configuration another process changed (V2.4 item 7.1). The app
   * reloads the moment it saves; the worker has no request to react to, so it
   * asks for the version number on an interval. One integer column, no join.
   */
  startWatching(intervalMs: number): void {
    if (this.poller || intervalMs <= 0) return;
    let known = this.options.live.current.version;
    this.poller = setInterval(() => {
      void (async () => {
        try {
          const version = await this.store.readVersion();
          if (version === known) return;
          known = version;
          await this.reload();
        } catch (error) {
          // A poll that fails leaves the process on the configuration it has,
          // which is the safe answer: never fall back to no configuration.
          this.logger.warn(
            `model configuration poll failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
      })();
    }, intervalMs);
    this.poller.unref?.();
  }

  onModuleDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  /** Re-resolve from the database into the live configuration. */
  async reload(): Promise<ResolvedModelProviders> {
    const resolved = await this.resolveCurrent();
    if (this.options.live.replace(resolved)) {
      this.logger.log(
        `model configuration reloaded: ${resolved.id} (version ${this.options.live.current.version})`,
      );
    }
    return this.options.live.current;
  }

  private async resolveCurrent(): Promise<ResolvedModelProviders> {
    const [providers, assignments, answerOptions, version] = await Promise.all([
      this.store.listProvidersWithSecrets(),
      this.store.listAssignments(),
      this.store.listAnswerOptions(),
      this.store.readVersion(),
    ]);
    return resolveFromRecords({
      // Same posture as the boot path: an unreadable key disqualifies that
      // provider and nothing else, loudly, so the page that fixes it stays up.
      onUnreadable: (provider) =>
        this.logger.error(
          `provider "${provider.label}" is unusable: ${provider.reason} ` +
            `(its tiers are unconfigured until the key is re-entered)`,
        ),
      providers,
      assignments,
      answerOptions,
      version,
      masterKey: this.options.masterKey,
      redacted: this.options.redacted,
      reasoningHeadroom: this.options.reasoningHeadroom,
      timeoutsMs: this.options.timeoutsMs,
    });
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  async listProviders(): Promise<ProviderDto[]> {
    const [rows, assignments] = await Promise.all([
      this.store.listProviders(),
      this.store.listAssignments(),
    ]);
    return rows.map((row) => this.toProviderDto(row, assignments));
  }

  async createProvider(principal: Principal, request: CreateProviderRequest): Promise<ProviderDto> {
    if (!isCreatableProviderType(request.type)) {
      throw new BadRequestException(`"${request.type}" is not a provider type that can be created`);
    }
    const type = request.type as StoredProviderType;
    const spec = PROVIDER_TYPE_SPECS[type];
    const label = request.label.trim();
    if (!label) throw new BadRequestException('a provider needs a label');
    if (await this.store.findProviderByLabel(label)) {
      throw new ConflictException(`a provider called "${label}" already exists`);
    }
    const baseUrl = this.validateBaseUrl(type, request.baseUrl);
    if (spec.needsApiKey && !request.apiKey) {
      throw new BadRequestException(`a ${type} provider needs an API key`);
    }
    const record = await this.store.createProvider({
      label,
      type,
      baseUrl,
      apiKeySecret: request.apiKey ? sealSecret(this.options.masterKey, request.apiKey) : null,
    });
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'model_provider.created',
      entityType: 'model_provider',
      entityId: record.id,
      orgId: principal.orgId,
      // A type and two booleans. Never the credential, and never the endpoint
      // itself: a base URL can carry a token in a query string.
      detail: { type, hasApiKey: !!request.apiKey },
    });
    await this.bumpAndReload();
    return this.toProviderDto(record, await this.store.listAssignments());
  }

  async updateProvider(
    principal: Principal,
    id: string,
    request: UpdateProviderRequest,
  ): Promise<ProviderDto> {
    const existing = await this.store.findProvider(id);
    if (!existing) throw new NotFoundException('no such provider');
    const type = existing.type as StoredProviderType;
    const patch: { label?: string; baseUrl?: string | null; apiKeySecret?: string | null } = {};
    if (request.label !== undefined) {
      const label = request.label.trim();
      if (!label) throw new BadRequestException('a provider needs a label');
      const clash = await this.store.findProviderByLabel(label);
      if (clash && clash.id !== id) {
        throw new ConflictException(`a provider called "${label}" already exists`);
      }
      patch.label = label;
    }
    if (request.baseUrl !== undefined) patch.baseUrl = this.validateBaseUrl(type, request.baseUrl);
    if (request.apiKey !== undefined) {
      patch.apiKeySecret = request.apiKey
        ? sealSecret(this.options.masterKey, request.apiKey)
        : null;
    }
    const updated = await this.store.updateProvider(id, patch);
    if (!updated) throw new NotFoundException('no such provider');
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'model_provider.updated',
      entityType: 'model_provider',
      entityId: id,
      orgId: principal.orgId,
      // Which FIELDS moved, never their values.
      detail: { fields: Object.keys(patch) },
    });
    await this.bumpAndReload();
    return this.toProviderDto(updated, await this.store.listAssignments());
  }

  async deleteProvider(principal: Principal, id: string): Promise<void> {
    const assignments = await this.store.listAssignments();
    const bound = assignments.filter((row) => row.providerId === id).map((row) => row.tier);
    if (bound.length > 0) {
      throw new ConflictException(
        `this provider still serves the ${bound.join(', ')} tier(s): reassign them first`,
      );
    }
    await this.store.deleteProvider(id);
    this.health.delete(id);
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'model_provider.deleted',
      entityType: 'model_provider',
      entityId: id,
      orgId: principal.orgId,
    });
    await this.bumpAndReload();
  }

  /** Probe a saved provider's endpoint and remember the outcome for the list. */
  async probeProvider(id: string): Promise<ProviderProbeDto> {
    const target = await this.targetFor(id);
    const result = await listProviderModels(target);
    this.health.set(id, {
      state: result.ok ? 'ok' : result.reason === 'auth_failed' ? 'auth_failed' : 'unreachable',
      detail: result.ok ? (result.detail ?? null) : (result.error ?? null),
      checkedAt: new Date(),
    });
    return {
      ok: result.ok,
      reason: result.reason ?? null,
      detail: result.detail ?? result.error ?? null,
    };
  }

  /**
   * What this endpoint advertises. Never authoritative: a proxied deployment
   * legitimately serves models its `/models` route does not list, which is why
   * `mayBePartial` is true for every self-hosted endpoint and why manual entry
   * is offered in every case, including this one failing outright.
   */
  async listModels(id: string): Promise<ProviderModelsDto> {
    const provider = await this.store.findProvider(id);
    if (!provider) throw new NotFoundException('no such provider');
    const target = await this.targetFor(id);
    const result = await listProviderModels(target);
    return {
      models: result.models ?? [],
      error: result.ok ? null : (result.error ?? 'the model list could not be read'),
      mayBePartial: PROVIDER_TYPE_SPECS[provider.type as StoredProviderType]?.selfHosted ?? false,
    };
  }

  // ── Assignments ───────────────────────────────────────────────────────────

  async configuration(): Promise<ModelConfigurationDto> {
    const [providers, assignments, options, history] = await Promise.all([
      this.store.listProviders(),
      this.store.listAssignments(),
      this.store.listAnswerOptions(),
      this.store.recentChanges(HISTORY_LIMIT),
    ]);
    const byId = new Map(providers.map((row) => [row.id, row]));
    const live = this.options.live.current;
    const assignmentFor = (tier: ModelTierName): ProviderAssignmentDto => {
      const row = assignments.find((entry) => entry.tier === tier);
      const provider = row ? byId.get(row.providerId) : undefined;
      return {
        tier,
        providerId: row?.providerId ?? null,
        providerLabel: provider?.label ?? null,
        providerType: (provider?.type as StoredProviderType) ?? null,
        model: row?.model ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    };
    return {
      configurationId: live.id,
      configured: live.configured,
      assignments: [
        assignmentFor('pipeline'),
        assignmentFor('answer'),
        assignmentFor('embeddings'),
        assignmentFor('vision'),
      ],
      trust: await summariseTrustFor(this.options.trustScoresDir, live.id),
      history: history.map((row): ConfigurationChangeDto => ({
        id: row.id,
        configurationId: row.configurationId,
        previousConfigurationId: row.previousConfigurationId,
        tier: row.tier as ModelTierName,
        providerLabel: row.providerLabel,
        model: row.model,
        changedAt: row.changedAt.toISOString(),
      })),
      // Null on a full instance: the embeddings tier changes through the
      // managed rebuild below. Non-null only where no memory module is wired
      // into this process, and the operator command is then the honest path.
      embeddingsLocked: this.embeddingRebuild ? null : { operatorCommand: REINDEX_COMMAND },
      embeddingRebuild: this.embeddingRebuild ? await this.embeddingRebuild.status() : null,
      answerOptions: options.map((option) => this.toAnswerOptionDto(option, byId)),
    };
  }

  // ── The managed embedding rebuild (V2.4 item 7.1 second half) ─────────────

  /**
   * What changing the embeddings model to this binding will do and cost,
   * BEFORE anything is saved: the corpus size in facts, the token estimate
   * under the same chars/4 accounting the meter charges, a duration
   * extrapolated from a real probed embedding, the model's probed dimension,
   * and whether the resulting configuration has published trust scores.
   * Nothing is written; only explicit confirmation (`beginEmbeddingsRebuild`)
   * begins anything.
   */
  async planEmbeddingsRebuild(request: EmbeddingRebuildRequest): Promise<EmbeddingRebuildPlanDto> {
    const rebuild = this.requireRebuild();
    if (await rebuild.status()) {
      throw new ConflictException('an embeddings rebuild already exists; cancel or resume it');
    }
    const { provider, spec } = await this.embeddingsCandidate(request);
    const probe = await probeProviderModel(await this.targetFor(provider.id), {
      tier: 'embeddings',
      model: request.model,
    });
    if (!probe.ok || !probe.dimensions) {
      throw new BadRequestException({
        message: probe.error ?? 'the model did not answer the embedding probe',
        reason: probe.reason ?? 'unusable_response',
      });
    }
    const corpus = await rebuild.corpus();
    // One request per batch of 64, extrapolated from the probe's measured
    // latency. An estimate, stated as one; the live view refines it by rate.
    const batches = Math.ceil(corpus.facts / 64);
    const estimatedSeconds = Math.max(1, Math.ceil((batches * (probe.latencyMs ?? 1_000)) / 1_000));
    const live = this.options.live.current;
    const resultingConfigurationId = live.configured
      ? deriveProvidersId(
          { ...live.tiers, embedding: { provider: spec.providerId, model: request.model } },
          live.redacted,
          live.vision,
        )
      : 'unconfigured';
    const trust = await summariseTrustFor(this.options.trustScoresDir, resultingConfigurationId);
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      model: request.model,
      facts: corpus.facts,
      estimatedTokens: corpus.estimatedTokens,
      estimatedSeconds,
      dimensions: probe.dimensions,
      resultingConfigurationId,
      evaluated: trust.evaluated,
    };
  }

  /**
   * Explicit confirmation of the plan: records the pending model beside the
   * active one and starts the worker job. From here everything is automatic;
   * the active configuration is untouched until the completed switch.
   */
  async beginEmbeddingsRebuild(
    principal: Principal,
    request: EmbeddingRebuildRequest,
  ): Promise<ModelConfigurationDto> {
    const plan = await this.planEmbeddingsRebuild(request);
    await this.rebuildVerb(() =>
      this.requireRebuild().begin({
        target: {
          providerId: plan.providerId,
          providerLabel: plan.providerLabel,
          model: plan.model,
          dimensions: plan.dimensions,
        },
        requestedBy: principal.userId,
        orgId: principal.orgId,
      }),
    );
    return this.configuration();
  }

  async cancelEmbeddingsRebuild(principal: Principal): Promise<ModelConfigurationDto> {
    await this.rebuildVerb(() =>
      this.requireRebuild().cancel({ requestedBy: principal.userId, orgId: principal.orgId }),
    );
    return this.configuration();
  }

  async resumeEmbeddingsRebuild(principal: Principal): Promise<ModelConfigurationDto> {
    await this.rebuildVerb(() =>
      this.requireRebuild().resume({ requestedBy: principal.userId, orgId: principal.orgId }),
    );
    return this.configuration();
  }

  async embeddingRebuildStatus(): Promise<EmbeddingRebuildStatusDto | null> {
    return this.embeddingRebuild ? this.embeddingRebuild.status() : null;
  }

  /**
   * The switch port the worker root binds into the rebuild pass: the flip of
   * the stored embeddings assignment inside the switch transaction, and the
   * reload-and-record that follows the commit. This is the ONE path that
   * changes the embeddings assignment, and it runs only after the new index
   * verified complete.
   */
  embeddingsSwitchPort(): EmbeddingSwitchPort {
    return {
      commit: async (tx: Tx, change) => {
        const store = new ProviderStore(tx);
        await store.putAssignment({
          tier: 'embeddings',
          providerId: change.providerId,
          model: change.model,
          updatedBy: change.changedBy,
        });
        await store.bumpVersion();
      },
      afterCommit: async (change) => {
        const previousId = this.options.live.current.id;
        await this.reload();
        await this.store.recordChange({
          configurationId: this.options.live.current.id,
          previousConfigurationId: previousId,
          tier: 'embeddings',
          providerLabel: change.providerLabel,
          model: change.model,
          changedBy: change.changedBy,
        });
        await writeAudit(this.db, {
          actor: change.changedBy ? `user:${change.changedBy}` : 'worker:embedding-rebuild',
          action: 'model_assignment.changed',
          entityType: 'model_assignment',
          entityId: 'embeddings',
          ...(change.orgId ? { orgId: change.orgId } : {}),
          detail: {
            configurationId: this.options.live.current.id,
            previousConfigurationId: previousId,
          },
        });
      },
    };
  }

  /** Probe a candidate embeddings binding by USE — public for the operator
   * CLI, which validates its target the same way the interface does. */
  async probeEmbeddingsModel(providerId: string, model: string): Promise<ProviderProbeResult> {
    return probeProviderModel(await this.targetFor(providerId), { tier: 'embeddings', model });
  }

  /** The resolved single-binding configuration the rebuild embeds through —
   * built here because opening the sealed key stays inside this module. */
  async embeddingRunProvidersFor(
    providerId: string,
    model: string,
  ): Promise<ResolvedModelProviders> {
    return embeddingRunConfiguration(await this.targetFor(providerId), model);
  }

  /** Validate a rebuild candidate: the provider exists, its type has an
   * embeddings API, and the binding is not already the active one. */
  private async embeddingsCandidate(request: EmbeddingRebuildRequest): Promise<{
    provider: ProviderRecord;
    spec: (typeof PROVIDER_TYPE_SPECS)[StoredProviderType];
  }> {
    const provider = await this.store.findProvider(request.providerId);
    if (!provider) throw new NotFoundException('no such provider');
    const spec = PROVIDER_TYPE_SPECS[provider.type as StoredProviderType];
    if (!spec) throw new BadRequestException('this provider has an unknown type');
    if (!spec.supportsEmbeddings) {
      throw new BadRequestException('this provider type has no embeddings API');
    }
    const active = this.options.live.current.tiers.embedding;
    if (
      this.options.live.current.configured &&
      active.endpoint?.id === provider.id &&
      active.model === request.model
    ) {
      throw new BadRequestException('that is already the active embeddings model');
    }
    return { provider, spec };
  }

  private requireRebuild(): EmbeddingRebuildService {
    if (!this.embeddingRebuild) {
      throw new ConflictException(
        `the managed rebuild is unavailable in this process; the operator path is ` +
          `\`${REINDEX_COMMAND}\``,
      );
    }
    return this.embeddingRebuild;
  }

  /** Map the engine's conflict errors onto the HTTP conflict they are. */
  private async rebuildVerb(verb: () => Promise<void>): Promise<void> {
    try {
      await verb();
    } catch (error) {
      if (error instanceof EmbeddingRebuildConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  /**
   * Assign a tier. Explicit and confirmed by construction: this endpoint is the
   * only way an assignment changes, and it validates by PROBING before it
   * stores, so a save either works or says precisely why not.
   */
  async assignTier(
    principal: Principal,
    tier: ModelTierName,
    request: { providerId: string | null; model: string | null },
  ): Promise<ModelConfigurationDto> {
    if (tier === 'embeddings') {
      throw new ConflictException(
        'the embeddings model cannot be assigned directly: every stored vector was produced ' +
          'by the current model, and serving a mixed embedding space would silently corrupt ' +
          'every search result. Use the embeddings rebuild flow, which re-embeds the corpus ' +
          'into a new index and switches atomically at completion.',
      );
    }
    const previousId = this.options.live.current.id;

    if (!request.providerId || !request.model) {
      if (tier !== 'vision') {
        throw new BadRequestException(`the ${tier} tier cannot be left unassigned`);
      }
      // Vision alone may be cleared: no vision binding is a complete answer,
      // and the reading ladder stops at OCR and says so (V2.1 item 4.1).
      await this.store.clearAssignment('vision');
      await this.recordChange(principal, previousId, 'vision', 'none', 'unassigned');
      return this.configuration();
    }

    const provider = await this.store.findProvider(request.providerId);
    if (!provider) throw new NotFoundException('no such provider');
    const spec = PROVIDER_TYPE_SPECS[provider.type as StoredProviderType];
    if (!spec) throw new BadRequestException('this provider has an unknown type');

    const probe = await probeProviderModel(await this.targetFor(provider.id), {
      tier: probeTierFor(tier),
      model: request.model,
    });
    if (!probe.ok) {
      throw new BadRequestException({
        message: probe.error ?? 'the model did not answer the probe',
        reason: probe.reason ?? 'unusable_response',
      });
    }

    await this.store.putAssignment({
      tier,
      providerId: provider.id,
      model: request.model,
      updatedBy: principal.userId,
    });
    await this.recordChange(principal, previousId, tier, provider.label, request.model);
    return this.configuration();
  }

  // ── The answer models users may pick between ──────────────────────────────

  async addAnswerOption(
    principal: Principal,
    request: { providerId: string; model: string; label: string },
  ): Promise<ModelConfigurationDto> {
    const provider = await this.store.findProvider(request.providerId);
    if (!provider) throw new NotFoundException('no such provider');
    const probe = await probeProviderModel(await this.targetFor(provider.id), {
      tier: 'generation',
      model: request.model,
    });
    if (!probe.ok) {
      throw new BadRequestException({
        message: probe.error ?? 'the model did not answer the probe',
        reason: probe.reason ?? 'unusable_response',
      });
    }
    await this.store.addAnswerOption({
      providerId: provider.id,
      model: request.model,
      label: request.label.trim() || request.model,
    });
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'model_answer_option.added',
      entityType: 'model_answer_option',
      entityId: provider.id,
      orgId: principal.orgId,
    });
    await this.bumpAndReload();
    return this.configuration();
  }

  async removeAnswerOption(principal: Principal, id: string): Promise<ModelConfigurationDto> {
    await this.store.removeAnswerOption(id);
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'model_answer_option.removed',
      entityType: 'model_answer_option',
      entityId: id,
      orgId: principal.orgId,
    });
    await this.bumpAndReload();
    return this.configuration();
  }

  /** The user-facing surface: their choice, and what is available to choose. */
  async answerModelFor(principal: Principal): Promise<UserAnswerModelDto> {
    const [chosen, options, providers] = await Promise.all([
      this.store.answerOptionFor(principal.userId),
      this.store.listAnswerOptions(),
      this.store.listProviders(),
    ]);
    const byId = new Map(providers.map((row) => [row.id, row]));
    const dtos = options.map((option) => this.toAnswerOptionDto(option, byId));
    const active = dtos.find((option) => option.id === chosen);
    return {
      optionId: active?.id ?? null,
      activeLabel: active?.label ?? this.options.live.current.tiers.answer.model,
      options: dtos,
    };
  }

  async setAnswerModelFor(
    principal: Principal,
    optionId: string | null,
  ): Promise<UserAnswerModelDto> {
    if (optionId === null) {
      await this.store.clearAnswerOptionFor(principal.userId);
      return this.answerModelFor(principal);
    }
    const options = await this.store.listAnswerOptions();
    if (!options.some((option) => option.id === optionId)) {
      throw new BadRequestException('that answer model is not one this instance offers');
    }
    await this.store.setAnswerOptionFor(principal.userId, principal.orgId, optionId);
    return this.answerModelFor(principal);
  }

  /**
   * The option id a user's answers should route to, for the chat path. Returns
   * null when they have made no choice, which is every user on an instance whose
   * admin enabled none — and null is what keeps that path byte-identical.
   */
  async optionIdFor(userId: string): Promise<string | null> {
    if (this.options.live.current.answerOptions.length === 0) return null;
    const chosen = await this.store.answerOptionFor(userId);
    if (!chosen) return null;
    return this.options.live.current.answerOptions.some((option) => option.id === chosen)
      ? chosen
      : null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The probe target for a saved provider: the one place outside the resolver
   * that opens a sealed key, and it hands it straight to the seam without ever
   * putting it in a field anything else reads.
   */
  private async targetFor(id: string): Promise<ProbeTarget> {
    const rows = await this.store.listProvidersWithSecrets();
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new NotFoundException('no such provider');
    const type = row.type as StoredProviderType;
    const spec = PROVIDER_TYPE_SPECS[type];
    if (!spec) throw new BadRequestException('this provider has an unknown type');
    const baseUrl = adapterBaseUrl(type, row.baseUrl);
    return {
      provider: spec.providerId,
      ...(baseUrl ? { baseUrl: type === 'ollama' ? `${baseUrl}/v1` : baseUrl } : {}),
      apiKey: row.apiKeySecret
        ? openSecret(this.options.masterKey, row.apiKeySecret)
        : NO_AUTH_PLACEHOLDER,
      selfHosted: spec.selfHosted,
    };
  }

  private toProviderDto(
    row: ProviderRecord,
    assignments: { tier: string; providerId: string }[],
  ): ProviderDto {
    const type = row.type as StoredProviderType;
    const spec = PROVIDER_TYPE_SPECS[type];
    const health = this.health.get(row.id);
    return {
      id: row.id,
      label: row.label,
      type,
      baseUrl: row.baseUrl,
      hasApiKey: row.hasApiKey,
      requiresApiKey: spec?.needsApiKey ?? false,
      supportsEmbeddings: spec?.supportsEmbeddings ?? false,
      health: {
        state: health?.state ?? 'unknown',
        detail: health?.detail ?? null,
        checkedAt: health?.checkedAt.toISOString() ?? null,
      },
      assignedTiers: assignments
        .filter((entry) => entry.providerId === row.id)
        .map((entry) => entry.tier as ModelTierName),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAnswerOptionDto(
    option: { id: string; label: string; providerId: string; model: string },
    byId: Map<string, ProviderRecord>,
  ): AnswerModelOptionDto {
    const provider = byId.get(option.providerId);
    return {
      id: option.id,
      label: option.label,
      providerId: option.providerId,
      providerLabel: provider?.label ?? 'unknown',
      providerType: (provider?.type as StoredProviderType) ?? 'self_hosted',
      model: option.model,
    };
  }

  private validateBaseUrl(type: StoredProviderType, baseUrl: string | undefined): string | null {
    const spec = PROVIDER_TYPE_SPECS[type];
    const trimmed = baseUrl?.trim();
    if (!trimmed) {
      if (spec.needsBaseUrl) throw new BadRequestException('this provider type needs an endpoint');
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('the endpoint is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('the endpoint must be an http or https URL');
    }
    return trimmed.replace(/\/+$/, '');
  }

  /**
   * Record the change, bump the version so every process picks it up, and
   * reload this one immediately. The recorded row is what makes "you moved off
   * a measured configuration, here is when" answerable later.
   */
  private async recordChange(
    principal: Principal,
    previousConfigurationId: string,
    tier: ModelTierName,
    providerLabel: string,
    model: string,
  ): Promise<void> {
    await this.bumpAndReload();
    const configurationId = this.options.live.current.id;
    await this.store.recordChange({
      configurationId,
      previousConfigurationId,
      tier,
      providerLabel,
      model,
      changedBy: principal.userId,
    });
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'model_assignment.changed',
      entityType: 'model_assignment',
      entityId: tier,
      orgId: principal.orgId,
      // The configuration id is not content: it is the published join key, and
      // an admin needs to see in the trail when the instance moved off one.
      detail: { configurationId, previousConfigurationId },
    });
  }

  private async bumpAndReload(): Promise<void> {
    await this.store.bumpVersion();
    await this.reload();
  }
}

/** The tier a model is validated FOR: the job it will actually be asked to do. */
function probeTierFor(tier: ModelTierName): ProbeTier {
  if (tier === 'embeddings') return 'embeddings';
  if (tier === 'vision') return 'vision';
  return 'generation';
}

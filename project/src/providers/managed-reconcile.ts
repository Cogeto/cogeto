import { sql } from 'drizzle-orm';
import {
  MasterKeyError,
  openSecret,
  sealSecret,
  SecretUnreadableError,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { createModelGateway, probeProviderModel } from '../model-gateway/index';
import type { ProbeTarget } from '../model-gateway/index';
import { createEmbeddingRebuild, EmbeddingRebuildConflictError } from '../memory/index';
import { ProviderStore } from './persistence/provider-store';
import type { ProviderRecord } from './persistence/provider-store';
import { adapterBaseUrl } from './domain/provider-types';
import { parseManagedProviderConfig, upstreamIdentityOf } from './domain/managed-config';
import type { ManagedProviderConfig } from './domain/managed-config';
import type { ProviderConfigService } from './provider-config.service';

/**
 * The boot-time managed provider reconciler (hosted provisioning, task A).
 *
 * Both composition roots call this after the database's model configuration is
 * in force and before anything serves. The contract, in order of what matters:
 *
 * 1. **Absent configuration is a no-op.** Neither the file nor the key set
 *    means no managed provider, and the product is byte-identical to an
 *    instance that never heard of the feature. One without the other refuses
 *    the boot, naming what is missing: never guess, never partially apply.
 * 2. **Reconciliation touches only the managed row.** A hand-configured
 *    provider, including one pointing at the same endpoint, is byte-identical
 *    before and after every boot; the integration spec compares every field.
 * 3. **The embeddings tier never changes geometry silently.** Any change to
 *    the upstream identity behind the served embeddings model the instance is
 *    on refuses the whole reconcile, and the boot, with a message naming the
 *    honest path: a NEW served name plus the managed rebuild, or
 *    `cogeto reindex`.
 * 4. **Initial assignments apply once**: pipeline, answer and vision when the
 *    row is first created and the tier is unassigned (afterwards assignments
 *    belong to the instance); embeddings whenever the tier is unassigned,
 *    through the ordinary rebuild engine with a probed dimension, so a crash
 *    between creation and the switch resumes instead of stranding the tier.
 * 5. **Key rotation is re-render and restart.** The stored ciphertext is
 *    replaced, never kept beside a successor.
 *
 * Every reconcile writes one audit entry with structural detail only: an
 * outcome, field names, counts. Never the key, never an upstream identifier.
 */

export class ManagedReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedReconcileError';
  }
}

export interface ManagedReconcileInput {
  /** The rendered file's contents, or null when the variable is unset. */
  fileContent: string | null;
  /** Where the contents came from, for messages (the file path). */
  fileSource: string | null;
  /** The bootstrap key from the environment, or null when unset. */
  apiKey: string | null;
}

export interface ManagedReconcileDeps {
  db: Db;
  /** The same service the interface uses: reload, the switch port, probes. */
  service: ProviderConfigService;
  masterKey: Buffer | null;
  qdrant: { url: string; apiKey?: string };
  /** The active embeddings model, for the rebuild engine's serving side. */
  activeEmbeddingModel: string;
  redaction?: { enabled: boolean; url: string; timeoutMs?: number };
  probeTimeoutMs?: number;
  log?: (message: string) => void;
}

/** Serializes the two roots' concurrent reconciles; transaction-scoped. */
const RECONCILE_LOCK = 'cogeto:managed-provider-reconcile';

interface ReconcileOutcome {
  outcome: 'created' | 'updated' | 'unchanged';
  providerId: string;
  fields: string[];
  appliedTiers: { tier: string; model: string }[];
}

export async function reconcileManagedProvider(
  input: ManagedReconcileInput,
  deps: ManagedReconcileDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);
  if (input.fileContent === null && input.apiKey === null) return;
  if (input.fileContent === null) {
    throw new ManagedReconcileError(
      'COGETO_MANAGED_PROVIDER_API_KEY is set but COGETO_MANAGED_PROVIDER_FILE is not: ' +
        'the managed provider needs both, refusing to guess',
    );
  }
  if (input.apiKey === null) {
    throw new ManagedReconcileError(
      'COGETO_MANAGED_PROVIDER_FILE is set but COGETO_MANAGED_PROVIDER_API_KEY is not: ' +
        'the managed provider needs both, refusing to guess',
    );
  }
  if (!deps.masterKey) {
    throw new ManagedReconcileError(
      'the managed provider key cannot be sealed without COGETO_MASTER_KEY: set it and restart',
    );
  }
  const masterKey = deps.masterKey;
  const apiKey = input.apiKey;
  const config = parseManagedProviderConfig(input.fileContent, input.fileSource ?? 'the file');

  const store = new ProviderStore(deps.db);
  const probeTarget: ProbeTarget = {
    provider: 'openai',
    baseUrl: adapterBaseUrl('self_hosted', config.baseUrl),
    apiKey,
    selfHosted: true,
    modelAliases: config.models,
  };

  // Phase A, no lock: what state are we in, and which probes does it need?
  // Probes are network work and run before the locked transaction; the
  // transaction re-checks the state it acts on, so a race with the other root
  // resolves as one creator and one no-op update.
  const existing = await store.findManagedProvider();
  const assignments = await store.listAssignments();
  const assignedTiers = new Set(assignments.map((row) => row.tier));

  const creation = !existing;
  let visionUsable = false;
  if (creation) {
    for (const tier of ['pipeline', 'answer'] as const) {
      if (assignedTiers.has(tier)) continue;
      const probe = await probeProviderModel(probeTarget, {
        tier: 'generation',
        model: config.assign[tier],
        ...(deps.probeTimeoutMs !== undefined ? { timeoutMs: deps.probeTimeoutMs } : {}),
      });
      if (!probe.ok) {
        throw new ManagedReconcileError(
          `the managed provider's ${tier} model "${config.assign[tier]}" failed its probe ` +
            `(${probe.reason ?? 'unusable_response'}); fix the endpoint or the configuration ` +
            `and restart`,
        );
      }
    }
    if (config.assign.vision && !assignedTiers.has('vision')) {
      // The vision probe sends a real image, because a name proves nothing
      // about whether multimodal input is actually served. A refusal leaves
      // vision unassigned, which is the designed behaviour, stated here and
      // in the audit entry rather than papered over.
      const probe = await probeProviderModel(probeTarget, {
        tier: 'vision',
        model: config.assign.vision,
        ...(deps.probeTimeoutMs !== undefined ? { timeoutMs: deps.probeTimeoutMs } : {}),
      });
      visionUsable = probe.ok;
      if (!probe.ok) {
        log(
          `managed provider: the vision model "${config.assign.vision}" did not pass the ` +
            `image probe (${probe.reason ?? 'unusable_response'}); the vision tier stays ` +
            `unassigned and the reading ladder stops at OCR`,
        );
      }
    }
  }

  // The embeddings dimension probe, whenever the tier is unassigned: the
  // first embeddings assignment goes through the ordinary rebuild engine,
  // which needs the model's TRUE dimension, never a registry guess.
  let embeddingDimensions: number | null = null;
  if (!assignedTiers.has('embeddings')) {
    const probe = await probeProviderModel(probeTarget, {
      tier: 'embeddings',
      model: config.assign.embeddings,
      ...(deps.probeTimeoutMs !== undefined ? { timeoutMs: deps.probeTimeoutMs } : {}),
    });
    if (!probe.ok || !probe.dimensions) {
      throw new ManagedReconcileError(
        `the managed provider's embeddings model "${config.assign.embeddings}" failed its ` +
          `probe (${probe.reason ?? 'unusable_response'}); fix the endpoint or the ` +
          `configuration and restart`,
      );
    }
    embeddingDimensions = probe.dimensions;
  }

  // Phase B: the one locked transaction that creates or converges the row.
  const result = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${RECONCILE_LOCK}, 0))`);
    const txStore = new ProviderStore(tx);
    const row = await txStore.findManagedProvider();
    if (!row) {
      return createManagedRow(txStore, config, { apiKey, masterKey, visionUsable });
    }
    return updateManagedRow(txStore, row, config, { apiKey, masterKey });
  });

  if (result.outcome !== 'unchanged') {
    await deps.service.reload();
    log(
      `managed provider ${result.outcome}: "${config.label}" now serves ` +
        `${Object.keys(config.models).length} model(s)`,
    );
  }

  // The audit entry, structural only: an outcome, field names and counts.
  // Never the key, never an endpoint, never an upstream identifier.
  await writeAudit(deps.db, {
    actor: 'system:managed-provider',
    action: 'model_provider.managed_reconciled',
    entityType: 'model_provider',
    entityId: result.providerId,
    detail: {
      outcome: result.outcome,
      fields: result.fields,
      servedModels: Object.keys(config.models).length,
      answerOptions: config.answerOptions.length,
      appliedTiers: result.appliedTiers.map((entry) => entry.tier),
    },
  });

  // Record the initial assignments in the configuration history the way any
  // other change is recorded, with the id the instance now runs under.
  if (result.appliedTiers.length > 0) {
    const configurationId = deps.service.liveConfigurationId();
    for (const applied of result.appliedTiers) {
      await store.recordChange({
        configurationId,
        previousConfigurationId: null,
        tier: applied.tier,
        providerLabel: config.label,
        model: applied.model,
        changedBy: 'managed-provider',
      });
    }
  }

  // The embeddings tier, through the ordinary rebuild engine: a new
  // collection at the probed dimension, the one-transaction switch, and the
  // assignment flip through the same port the interface's rebuild uses. On a
  // fresh instance the corpus is empty and this completes in one pass; after
  // a crash it resumes by adoption, exactly like `cogeto reindex`. Re-checked
  // here rather than trusted from phase A, because the OTHER composition root
  // may have completed the switch while this one waited on the lock.
  if (embeddingDimensions !== null) {
    const nowAssigned = (await store.listAssignments()).some((row) => row.tier === 'embeddings');
    if (!nowAssigned) {
      await driveEmbeddingsAssignment(deps, config, result.providerId, embeddingDimensions, log);
    }
    // Converge this process's live configuration NOW, whichever process
    // completed the switch: the loser of the drive race otherwise boots on
    // the pre-switch resolve and waits a poll interval to notice.
    await deps.service.reload();
  }
}

async function createManagedRow(
  txStore: ProviderStore,
  config: ManagedProviderConfig,
  context: { apiKey: string; masterKey: Buffer; visionUsable: boolean },
): Promise<ReconcileOutcome> {
  const clash = await txStore.findProviderByLabel(config.label);
  if (clash) {
    throw new ManagedReconcileError(
      `a provider labelled "${config.label}" already exists and is not the managed one; ` +
        `rename it in the interface or change the managed label, then restart`,
    );
  }
  const row = await txStore.createProvider({
    label: config.label,
    type: config.type,
    baseUrl: config.baseUrl,
    apiKeySecret: sealSecret(context.masterKey, context.apiKey),
    managed: true,
    modelAliases: config.models,
  });
  const assignments = await txStore.listAssignments();
  const assigned = new Set(assignments.map((entry) => entry.tier));
  const appliedTiers: { tier: string; model: string }[] = [];
  for (const tier of ['pipeline', 'answer'] as const) {
    if (assigned.has(tier)) continue;
    await txStore.putAssignment({
      tier,
      providerId: row.id,
      model: config.assign[tier],
      updatedBy: 'managed-provider',
    });
    appliedTiers.push({ tier, model: config.assign[tier] });
  }
  if (config.assign.vision && context.visionUsable && !assigned.has('vision')) {
    await txStore.putAssignment({
      tier: 'vision',
      providerId: row.id,
      model: config.assign.vision,
      updatedBy: 'managed-provider',
    });
    appliedTiers.push({ tier: 'vision', model: config.assign.vision });
  }
  for (const served of config.answerOptions) {
    await txStore.addAnswerOption({ providerId: row.id, model: served, label: served });
  }
  await txStore.bumpVersion();
  return { outcome: 'created', providerId: row.id, fields: [], appliedTiers };
}

async function updateManagedRow(
  txStore: ProviderStore,
  row: ProviderRecord,
  config: ManagedProviderConfig,
  context: { apiKey: string; masterKey: Buffer },
): Promise<ReconcileOutcome> {
  // The guards first, before anything is written: a refusal applies NOTHING.
  const assignments = await txStore.listAssignments();
  for (const assignment of assignments.filter((entry) => entry.providerId === row.id)) {
    if (!Object.hasOwn(config.models, assignment.model)) {
      throw new ManagedReconcileError(
        `the managed configuration no longer serves "${assignment.model}", which the ` +
          `${assignment.tier} tier is assigned to; keep serving it, or reassign the tier ` +
          `first, then restart`,
      );
    }
    if (
      assignment.tier === 'embeddings' &&
      upstreamIdentityOf(row.modelAliases, assignment.model) !==
        upstreamIdentityOf(config.models, assignment.model)
    ) {
      // The dangerous change: the upstream identity behind the served
      // embeddings model. Applying it would change vector geometry while
      // every query keeps returning plausible results, so the whole
      // reconcile refuses and the message names the honest path.
      throw new ManagedReconcileError(
        `the managed configuration changes the model behind "${assignment.model}", which is ` +
          `the embeddings model this instance's vectors were produced with. Refusing to ` +
          `apply it: a changed embeddings model must go through the managed reindex. ` +
          `Publish the new model under a NEW served name (keeping "${assignment.model}" ` +
          `unchanged), restart, and switch with the embeddings rebuild in the interface or ` +
          `with \`cogeto reindex --provider "${config.label}" --model <new-served-name>\`.`,
      );
    }
  }

  const fields: string[] = [];
  const patch: {
    label?: string;
    baseUrl?: string | null;
    apiKeySecret?: string;
    modelAliases?: Record<string, string>;
  } = {};
  if (row.label !== config.label) {
    const clash = await txStore.findProviderByLabel(config.label);
    if (clash && clash.id !== row.id) {
      throw new ManagedReconcileError(
        `a provider labelled "${config.label}" already exists and is not the managed one; ` +
          `rename it in the interface or change the managed label, then restart`,
      );
    }
    patch.label = config.label;
    fields.push('label');
  }
  if (row.baseUrl !== config.baseUrl) {
    patch.baseUrl = config.baseUrl;
    fields.push('baseUrl');
  }
  if (!sameAliases(row.modelAliases, config.models)) {
    patch.modelAliases = config.models;
    fields.push('modelAliases');
  }
  if (await keyRotated(txStore, row.id, context)) {
    // The previous ciphertext is REPLACED, never kept beside a successor:
    // rotation is re-render the environment and restart, nothing else.
    patch.apiKeySecret = sealSecret(context.masterKey, context.apiKey);
    fields.push('apiKey');
  }

  const options = (await txStore.listAnswerOptions()).filter(
    (option) => option.providerId === row.id,
  );
  const wanted = new Set(config.answerOptions);
  let optionsChanged = false;
  for (const option of options) {
    if (!wanted.has(option.model)) {
      await txStore.removeAnswerOption(option.id);
      optionsChanged = true;
    }
  }
  const present = new Set(options.map((option) => option.model));
  for (const served of config.answerOptions) {
    if (!present.has(served)) {
      await txStore.addAnswerOption({ providerId: row.id, model: served, label: served });
      optionsChanged = true;
    }
  }
  if (optionsChanged) fields.push('answerOptions');

  if (Object.keys(patch).length > 0) await txStore.updateProvider(row.id, patch);
  const changed = fields.length > 0;
  if (changed) await txStore.bumpVersion();
  return {
    outcome: changed ? 'updated' : 'unchanged',
    providerId: row.id,
    fields,
    appliedTiers: [],
  };
}

/** Has the environment's key moved away from the stored one? An unreadable
 * stored key (a master key that changed) counts as rotated: resealing under
 * the current master key is the recovery, not a failure. */
async function keyRotated(
  txStore: ProviderStore,
  providerId: string,
  context: { apiKey: string; masterKey: Buffer },
): Promise<boolean> {
  const rows = await txStore.listProvidersWithSecrets();
  const sealed = rows.find((candidate) => candidate.id === providerId)?.apiKeySecret;
  if (!sealed) return true;
  try {
    return openSecret(context.masterKey, sealed) !== context.apiKey;
  } catch (error) {
    if (error instanceof SecretUnreadableError || error instanceof MasterKeyError) return true;
    throw error;
  }
}

function sameAliases(
  left: Record<string, string> | null | undefined,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([served, upstream], index) =>
        rightEntries[index]![0] === served && rightEntries[index]![1] === upstream,
    )
  );
}

async function driveEmbeddingsAssignment(
  deps: ManagedReconcileDeps,
  config: ManagedProviderConfig,
  providerId: string,
  dimensions: number,
  log: (message: string) => void,
): Promise<void> {
  const rebuild = createEmbeddingRebuild({
    db: deps.db,
    qdrant: {
      url: deps.qdrant.url,
      ...(deps.qdrant.apiKey ? { apiKey: deps.qdrant.apiKey } : {}),
      embeddingModel: deps.activeEmbeddingModel,
    },
  });
  const existing = await rebuild.status();
  if (!existing) {
    try {
      await rebuild.begin({
        target: {
          providerId,
          providerLabel: config.label,
          model: config.assign.embeddings,
          dimensions,
        },
        requestedBy: 'managed-provider',
      });
    } catch (error) {
      // The other composition root won the begin between our status read and
      // this call. That is cooperation, not a conflict: adopt its rebuild.
      if (!(error instanceof EmbeddingRebuildConflictError)) throw error;
      log('managed provider: adopting the embeddings rebuild the other process began');
    }
  } else {
    log(
      `managed provider: adopting the embeddings rebuild already in flight ` +
        `(${existing.factsDone}/${existing.factsTotal})`,
    );
  }
  const passDeps = {
    gatewayFor: async (target: { providerId: string; model: string }) =>
      createModelGateway({
        providers: await deps.service.embeddingRunProvidersFor(target.providerId, target.model),
        ...(deps.redaction ? { redaction: deps.redaction } : {}),
      }),
    switchPort: deps.service.embeddingsSwitchPort(),
    log: (message: string) => log(`managed provider embeddings: ${message}`),
  };
  for (;;) {
    const { ran, outcome } = await rebuild.runPass(passDeps);
    if (!ran) {
      // Another process holds the single-flight lock and is advancing the
      // same rebuild; wait for it rather than duplicating the work.
      await sleep(2_000);
    } else if (outcome === 'completed') {
      return;
    } else if (outcome === 'failed' || outcome === 'cancelled' || outcome === 'paused_budget') {
      const status = await rebuild.status();
      throw new ManagedReconcileError(
        `the managed provider's first embeddings assignment did not complete ` +
          `(${outcome}${status?.error ? `: ${status.error}` : ''}); restart to resume, or ` +
          `finish it with \`cogeto reindex\``,
      );
    } else {
      const status = await rebuild.status();
      if (!status) return; // completed by the other process
      await sleep(2_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

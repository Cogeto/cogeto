import { deriveProvidersId, presetForTiers } from '../../model-gateway/index';
import { adapterBaseUrl, NO_AUTH_PLACEHOLDER, PROVIDER_TYPE_SPECS } from './provider-types';
import { MasterKeyError, openSecret, SecretUnreadableError } from '../../infrastructure/index';
import type { ProviderRecordWithSecret } from '../persistence/provider-store';
import type {
  AnswerModelOption,
  ProviderEndpoint,
  ResolvedModelProviders,
  TierBinding,
} from '../../model-gateway/index';
import type { ModelAnswerOptionRow, ModelAssignmentRow } from '../persistence/tables';
import type { StoredProviderType } from '@cogeto/shared';

/**
 * Stored rows to the gateway's resolved configuration (V2.4 item 7.1).
 *
 * This is the join between the two halves of the item: the admin edits records,
 * and the seam consumes exactly the shape it already consumed from the
 * environment. Nothing downstream of here can tell which source it came from,
 * which is why seeding an instance changes nothing about how it runs.
 *
 * The one thing this function does that no other does: it OPENS the sealed
 * keys. Decryption happens here because here is where a call is about to be
 * made, and the result goes straight into the gateway's endpoints and nowhere
 * else.
 */

/** A provider whose stored key could not be opened, and why. Never the key. */
export interface UnreadableProvider {
  id: string;
  label: string;
  reason: string;
}

export interface ResolveInput {
  providers: ProviderRecordWithSecret[];
  assignments: ModelAssignmentRow[];
  answerOptions: ModelAnswerOptionRow[];
  version: number;
  masterKey: Buffer | null;
  /** Redaction is still an environment fact: it is a deployment profile. */
  redacted: boolean;
  reasoningHeadroom: number;
  timeoutsMs: ResolvedModelProviders['timeoutsMs'];
  /**
   * Called for each provider whose sealed key could not be opened. The
   * composition root logs it; resolution continues without that provider.
   */
  onUnreadable?: (provider: UnreadableProvider) => void;
}

/**
 * An incomplete configuration is not an error: an instance whose three
 * generation and embedding tiers are not all assigned boots with model
 * features off and says so, exactly as an instance with no provider key did
 * before. The alternative — refusing to start — would lock an admin out of the
 * page they need to fix it.
 */
export function resolveFromRecords(input: ResolveInput): ResolvedModelProviders {
  const byId = new Map(input.providers.map((row) => [row.id, row]));
  // Negative entries too: a provider that cannot resolve is reported ONCE, not
  // once per tier bound to it.
  const endpointCache = new Map<string, ProviderEndpoint | null>();

  const endpointFor = (providerId: string): ProviderEndpoint | null => {
    if (endpointCache.has(providerId)) return endpointCache.get(providerId) ?? null;
    endpointCache.set(providerId, null);
    const row = byId.get(providerId);
    if (!row) return null;
    const type = row.type as StoredProviderType;
    const spec = PROVIDER_TYPE_SPECS[type];
    if (!spec) return null;
    /**
     * An unreadable key disqualifies THIS PROVIDER, and nothing else.
     *
     * The alternative was letting it throw, and that was measured to be the
     * wrong answer: a rotated or lost master key would refuse the boot, and an
     * admin cannot re-enter a key on a page an unstarted app does not serve.
     * Model features go off, the reason is logged loudly, and the interface
     * stays reachable, which is the same posture as an unconfigured instance.
     */
    let apiKey: string;
    try {
      apiKey = row.apiKeySecret
        ? openSecret(input.masterKey, row.apiKeySecret)
        : spec.needsApiKey
          ? ''
          : NO_AUTH_PLACEHOLDER;
    } catch (error) {
      if (error instanceof SecretUnreadableError || error instanceof MasterKeyError) {
        input.onUnreadable?.({ id: row.id, label: row.label, reason: error.message });
        return null;
      }
      throw error;
    }
    if (!apiKey) return null;
    const endpoint: ProviderEndpoint = {
      id: row.id,
      label: row.label,
      baseUrl: adapterBaseUrl(type, row.baseUrl),
      apiKey,
      selfHosted: spec.selfHosted,
    };
    endpointCache.set(providerId, endpoint);
    return endpoint;
  };

  const bindingFor = (tier: string): TierBinding | null => {
    const row = input.assignments.find((assignment) => assignment.tier === tier);
    if (!row) return null;
    const provider = byId.get(row.providerId);
    const endpoint = endpointFor(row.providerId);
    if (!provider || !endpoint) return null;
    return {
      provider: PROVIDER_TYPE_SPECS[provider.type as StoredProviderType]!.providerId,
      model: row.model,
      endpoint,
    };
  };

  const pipeline = bindingFor('pipeline');
  const answer = bindingFor('answer');
  const embedding = bindingFor('embeddings');
  const vision = bindingFor('vision');
  const configured = !!pipeline && !!answer && !!embedding;

  // An unconfigured instance still reports SOMETHING per tier, because the
  // Settings display and the boot log read these fields unconditionally. The
  // placeholder is honest rather than invented: it says nothing is assigned.
  const unassigned: TierBinding = { provider: 'mistral', model: 'unassigned' };
  const tiers = {
    pipeline: pipeline ?? unassigned,
    answer: answer ?? unassigned,
    embedding: embedding ?? unassigned,
  };

  const options: AnswerModelOption[] = [];
  for (const row of input.answerOptions) {
    const provider = byId.get(row.providerId);
    const endpoint = endpointFor(row.providerId);
    if (!provider || !endpoint) continue;
    options.push({
      id: row.id,
      label: row.label,
      binding: {
        provider: PROVIDER_TYPE_SPECS[provider.type as StoredProviderType]!.providerId,
        model: row.model,
        endpoint,
      },
    });
  }

  // The endpoint fields below are the ENVIRONMENT shape's instance-wide
  // fallbacks, kept because a tier that somehow arrives without its own
  // endpoint must not silently point at a vendor's hosted API. Nothing
  // resolved from records uses them: every binding carries its own endpoint.
  return {
    configured,
    id: configured ? deriveProvidersId(tiers, input.redacted, vision) : 'unconfigured',
    preset: configured ? presetForTiers(tiers) : null,
    tiers,
    vision,
    keys: {},
    endpoints: { openaiBaseUrl: '', anthropicBaseUrl: '' },
    ollama: null,
    timeoutsMs: input.timeoutsMs,
    reasoningHeadroom: input.reasoningHeadroom,
    openaiSelfHosted: false,
    redacted: input.redacted,
    source: 'database',
    version: input.version,
    answerOptions: options,
  };
}

import { PROVIDER_TYPE_SPECS } from './provider-types';
import { MASTER_KEY_MISSING, sealSecret } from '../../infrastructure/index';
import type { ProviderStore } from '../persistence/provider-store';
import type { ModelProviderId, ResolvedModelProviders } from '../../model-gateway/index';
import type { StoredProviderType } from '@cogeto/shared';

/**
 * Seeding the environment into the database, exactly once (V2.4 item 7.1).
 *
 * The rule this whole function exists to keep: **no working instance may
 * break**. An operator upgrades, starts the stack, and the instance runs the
 * configuration it was running before — same providers, same models, same
 * endpoint, same configuration id, no tier silently reassigned. The only
 * difference is that the configuration is now editable in the interface.
 *
 * "Exactly once" is enforced by an atomic claim on the state row rather than by
 * checking whether any providers exist: an admin who deletes every provider
 * must not have the environment resurrected underneath them on the next
 * restart. After the claim, the environment's model variables are IGNORED
 * forever, including when they are still sitting in `.env`.
 *
 * An instance with NO model configuration at all (no key, the implicit
 * mistral-default that boots with model features off) seeds nothing and is
 * marked seeded, which is the honest translation: there was nothing to carry
 * over, and the admin configures it in the interface.
 */

export interface SeedResult {
  seeded: boolean;
  /** Why nothing was seeded, when nothing was. */
  reason?: 'already_seeded' | 'nothing_configured' | 'claimed_by_another_process';
  providers: number;
  assignments: number;
}

/** How the reference deployment's `.env` translates, provider by provider. */
const SEED_LABEL: Readonly<Record<StoredProviderType, string>> = {
  mistral: 'Mistral',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  self_hosted: 'Self-hosted endpoint',
  ollama: 'Local Ollama runtime',
};

export async function seedFromEnvironment(
  store: ProviderStore,
  environment: ResolvedModelProviders,
  masterKey: Buffer | null,
): Promise<SeedResult> {
  const state = await store.readState();
  if (state.seededAt)
    return { seeded: false, reason: 'already_seeded', providers: 0, assignments: 0 };

  const bindings = [
    { tier: 'pipeline' as const, binding: environment.tiers.pipeline },
    { tier: 'answer' as const, binding: environment.tiers.answer },
    { tier: 'embeddings' as const, binding: environment.tiers.embedding },
    ...(environment.vision ? [{ tier: 'vision' as const, binding: environment.vision }] : []),
  ];

  if (!environment.configured) {
    // Nothing to carry over. Marked seeded anyway, so the next start does not
    // try again and so an admin's later choice to run with no provider at all
    // is respected rather than overwritten.
    if (!(await store.claimSeed('unconfigured'))) {
      return { seeded: false, reason: 'claimed_by_another_process', providers: 0, assignments: 0 };
    }
    return { seeded: true, providers: 0, assignments: 0 };
  }

  // The keys that must be encrypted, checked BEFORE anything is claimed: an
  // instance that cannot store its key must fail on the first start with the
  // command that fixes it, not half-seed and leave the configuration broken.
  const referenced = [...new Set(bindings.map((entry) => entry.binding.provider))];
  const needsMasterKey = referenced.some((provider) => realKeyFor(environment, provider) !== null);
  if (needsMasterKey && !masterKey) {
    throw new Error(
      `${MASTER_KEY_MISSING} (this instance has a provider API key in its environment that ` +
        `must be carried into the database)`,
    );
  }

  if (!(await store.claimSeed(seedSourceOf(environment)))) {
    return { seeded: false, reason: 'claimed_by_another_process', providers: 0, assignments: 0 };
  }

  try {
    const providerIdByGatewayId = new Map<ModelProviderId, string>();
    for (const provider of referenced) {
      const type = storedTypeFor(provider, environment);
      const key = realKeyFor(environment, provider);
      const record = await store.createProvider({
        label: SEED_LABEL[type],
        type,
        baseUrl: seedBaseUrl(type, environment),
        apiKeySecret: key ? sealSecret(masterKey, key) : null,
      });
      providerIdByGatewayId.set(provider, record.id);
    }
    for (const { tier, binding } of bindings) {
      await store.putAssignment({
        tier,
        providerId: providerIdByGatewayId.get(binding.provider)!,
        model: binding.model,
        updatedBy: null,
      });
    }
    return {
      seeded: true,
      providers: providerIdByGatewayId.size,
      assignments: bindings.length,
    };
  } catch (error) {
    // The claim is released so the next start retries rather than leaving the
    // instance permanently half-seeded with no way back to its configuration.
    await store.releaseSeed();
    throw error;
  }
}

/**
 * The stored type for a gateway provider id. The only interesting case is
 * `openai`, which is two different things: the hosted API and any
 * OpenAI-compatible server. The environment already answered that question
 * (`openaiSelfHosted`), so the seed does not have to guess.
 */
function storedTypeFor(
  provider: ModelProviderId,
  environment: ResolvedModelProviders,
): StoredProviderType {
  if (provider === 'openai') return environment.openaiSelfHosted ? 'self_hosted' : 'openai';
  return provider;
}

function seedBaseUrl(type: StoredProviderType, environment: ResolvedModelProviders): string | null {
  if (type === 'self_hosted') return environment.endpoints.openaiBaseUrl;
  if (type === 'ollama') return environment.ollama?.baseUrl ?? null;
  if (type === 'anthropic') {
    const configured = environment.endpoints.anthropicBaseUrl;
    return configured === PROVIDER_TYPE_SPECS.anthropic.defaultBaseUrl ? null : configured;
  }
  // Hosted OpenAI and Mistral: the adapter's own default is the endpoint, and
  // storing a copy of it would freeze today's URL into every instance.
  return null;
}

/**
 * A key worth encrypting. The resolver synthesizes placeholders for endpoints
 * that need no auth (`self-hosted`, `ollama`); carrying those into the database
 * as if they were credentials would be a lie in a column named `api_key`.
 */
function realKeyFor(environment: ResolvedModelProviders, provider: ModelProviderId): string | null {
  const key = environment.keys[provider];
  if (!key) return null;
  if (provider === 'ollama' && key === 'ollama') return null;
  if (provider === 'openai' && key === 'self-hosted') return null;
  return key;
}

/** A short description of the shape that was seeded, for the upgrade record. */
function seedSourceOf(environment: ResolvedModelProviders): string {
  return `environment:${environment.preset ?? 'custom'}`;
}

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_BASE_URL } from '../../model-gateway/index';
import type { ModelProviderId } from '../../model-gateway/index';
import { LEGACY_PROVIDER_TYPE, PROVIDER_TYPES } from '@cogeto/shared';
import type { ModelTierName, StoredProviderType } from '@cogeto/shared';

/**
 * What each provider family is, in one table (V2.4 item 7.1).
 *
 * The admin vocabulary is four types; the gateway's is four provider ids, and
 * they are deliberately not the same list. `self_hosted` is any
 * OpenAI-compatible endpoint and routes through the OpenAI-compatible adapter,
 * because that is what those servers speak. `ollama` is the reverse case: a
 * seeded value, never offered, kept so an instance already on the local runtime
 * keeps its adapter, its per-tier timeouts and its configuration id unchanged.
 */
export interface ProviderTypeSpec {
  /** The adapter family this type routes through. */
  providerId: ModelProviderId;
  /** Does this type need an endpoint from the admin? */
  needsBaseUrl: boolean;
  /** Does a call to it need a credential? */
  needsApiKey: boolean;
  /** Does it have an embeddings API at all (Anthropic has none)? */
  supportsEmbeddings: boolean;
  /**
   * Can a call through this type's adapter READ AN IMAGE (issue #571)?
   *
   * This is a fact about the adapter, not a claim about the vendor: it is true
   * exactly when the adapter this type routes through implements
   * `describeImage`. Anthropic's models are multimodal and its entry here is
   * still false, because `AnthropicModelGateway` has no image path, and a
   * capability table that describes what a vendor could do rather than what
   * this instance will do is the thing that produced the bug this closes.
   */
  supportsVision: boolean;
  /** Is it somebody's own server rather than a vendor's hosted API? */
  selfHosted: boolean;
  /** The hosted base URL, for the types that have one. */
  defaultBaseUrl: string | null;
  /** Offered when creating a provider? `ollama` is not. */
  creatable: boolean;
}

export const PROVIDER_TYPE_SPECS: Readonly<Record<StoredProviderType, ProviderTypeSpec>> = {
  mistral: {
    providerId: 'mistral',
    needsBaseUrl: false,
    needsApiKey: true,
    supportsEmbeddings: true,
    supportsVision: true,
    selfHosted: false,
    defaultBaseUrl: null,
    creatable: true,
  },
  openai: {
    providerId: 'openai',
    needsBaseUrl: false,
    needsApiKey: true,
    supportsEmbeddings: true,
    supportsVision: true,
    selfHosted: false,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    creatable: true,
  },
  anthropic: {
    providerId: 'anthropic',
    needsBaseUrl: false,
    needsApiKey: true,
    // Anthropic publishes no embeddings API (0040 ruling 3). This is the
    // capability gate the embeddings tier is validated against, and the reason
    // it is a fact in a table rather than a check somewhere in a controller.
    supportsEmbeddings: false,
    // No image path in AnthropicModelGateway. The models can see; this
    // adapter cannot, and the interface must say the second thing.
    supportsVision: false,
    selfHosted: false,
    defaultBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    creatable: true,
  },
  self_hosted: {
    providerId: 'openai',
    needsBaseUrl: true,
    // A server on your own hardware usually has no auth at all, and demanding
    // a meaningless placeholder is friction with no safety in it. A key is
    // accepted (an authenticating proxy in front of it is ordinary) and simply
    // not required.
    needsApiKey: false,
    supportsEmbeddings: true,
    // Whether the SERVER behind it has a multimodal model loaded is a
    // different question, and a probed one: the vision probe sends a real
    // image precisely because a GGUF model is multimodal only when its
    // projector is loaded and nothing in its name says so.
    supportsVision: true,
    selfHosted: true,
    defaultBaseUrl: null,
    creatable: true,
  },
  [LEGACY_PROVIDER_TYPE]: {
    providerId: 'ollama',
    needsBaseUrl: true,
    needsApiKey: false,
    supportsEmbeddings: true,
    supportsVision: true,
    selfHosted: true,
    defaultBaseUrl: null,
    creatable: false,
  },
};

export const isCreatableProviderType = (value: string): boolean =>
  (PROVIDER_TYPES as readonly string[]).includes(value);

/** Which capability this provider type is missing for a tier. */
export type TierCapabilityRefusal = 'vision_unsupported' | 'embeddings_unsupported';

/**
 * Why this provider cannot serve this tier, or null when it can (issue #571).
 *
 * A function beside the table rather than a check inside a controller, for the
 * reason the `supportsEmbeddings` comment already gives: the capability is a
 * fact about the type, and a rule that lives next to the fact cannot drift
 * away from it.
 *
 * It returns the REASON, not a sentence (F13). The words a user reads are
 * written where every other user-facing failure is written, at the throw site
 * with an error code the interface translates; a domain table has no business
 * holding English prose that only one language can render.
 */
export function tierCapabilityRefusal(
  tier: ModelTierName,
  spec: ProviderTypeSpec,
): TierCapabilityRefusal | null {
  if (tier === 'vision' && !spec.supportsVision) return 'vision_unsupported';
  if (tier === 'embeddings' && !spec.supportsEmbeddings) return 'embeddings_unsupported';
  return null;
}

/**
 * The adapter-ready base URL for a stored row.
 *
 * A self-hosted endpoint is entered as the OpenAI-compatible surface, `/v1`
 * included, because that is the URL an operator already has in front of them
 * from their proxy configuration. A trailing slash is tolerated because a
 * pasted URL usually has one, and the missing `/v1` is added because leaving it
 * off is the single most common way a first attempt fails.
 */
export function adapterBaseUrl(type: StoredProviderType, baseUrl: string | null): string {
  const spec = PROVIDER_TYPE_SPECS[type];
  const raw = (baseUrl ?? spec.defaultBaseUrl ?? '').replace(/\/+$/, '');
  if (!raw) return '';
  if (type === LEGACY_PROVIDER_TYPE) {
    // The Ollama binding names the runtime ROOT; the adapter derives `/v1`.
    return raw.replace(/\/v1$/, '');
  }
  if (type === 'self_hosted' && !/\/v\d+$/.test(raw)) return `${raw}/v1`;
  return raw;
}

/** The key an adapter presents when the endpoint needs none: never a real one. */
export const NO_AUTH_PLACEHOLDER = 'self-hosted';

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_BASE_URL } from '../../model-gateway/index';
import type { ModelProviderId } from '../../model-gateway/index';
import { LEGACY_PROVIDER_TYPE, PROVIDER_TYPES } from '@cogeto/shared';
import type { StoredProviderType } from '@cogeto/shared';

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
    selfHosted: false,
    defaultBaseUrl: null,
    creatable: true,
  },
  openai: {
    providerId: 'openai',
    needsBaseUrl: false,
    needsApiKey: true,
    supportsEmbeddings: true,
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
    selfHosted: true,
    defaultBaseUrl: null,
    creatable: true,
  },
  [LEGACY_PROVIDER_TYPE]: {
    providerId: 'ollama',
    needsBaseUrl: true,
    needsApiKey: false,
    supportsEmbeddings: true,
    selfHosted: true,
    defaultBaseUrl: null,
    creatable: false,
  },
};

export const isCreatableProviderType = (value: string): boolean =>
  (PROVIDER_TYPES as readonly string[]).includes(value);

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

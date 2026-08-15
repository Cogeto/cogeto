import { describe, expect, it } from 'vitest';
import { EMBEDDING_CAPABLE, VISION_CAPABLE } from '../../model-gateway/index';
import { PROVIDER_TYPE_SPECS, tierCapabilityRefusal } from './provider-types';
import type { StoredProviderType } from '@cogeto/shared';

/**
 * Provider capabilities (issue #571).
 *
 * Two paths ask the same question and must never disagree: the interface asks
 * `ProviderTypeSpec.supportsVision` before saving an assignment, and the eval
 * harness's environment resolver asks `VISION_CAPABLE`. When they drifted for
 * vision the interface offered Mistral, the resolver had no opinion at all, and
 * the failure surfaced three layers away as the base gateway reporting the
 * INSTANCE unconfigured.
 */
describe('provider capabilities', () => {
  const types = Object.keys(PROVIDER_TYPE_SPECS) as StoredProviderType[];

  it('the two capability tables agree, per type, for both optional tiers', () => {
    for (const type of types) {
      const spec = PROVIDER_TYPE_SPECS[type];
      expect(
        spec.supportsVision,
        `${type} routes through the ${spec.providerId} adapter: supportsVision disagrees with VISION_CAPABLE`,
      ).toBe(VISION_CAPABLE.includes(spec.providerId));
      expect(
        spec.supportsEmbeddings,
        `${type} routes through the ${spec.providerId} adapter: supportsEmbeddings disagrees with EMBEDDING_CAPABLE`,
      ).toBe(EMBEDDING_CAPABLE.includes(spec.providerId));
    }
  });

  it('each optional tier has at least one provider type an admin can create for it', () => {
    // The inverse of the bug: a tier the interface exposes and no creatable
    // type can serve is a control that cannot be satisfied. (Anthropic is
    // deliberately neither: it serves the generation tiers only, and those are
    // never gated.)
    const creatable = types.filter((type) => PROVIDER_TYPE_SPECS[type].creatable);
    expect(creatable.some((type) => PROVIDER_TYPE_SPECS[type].supportsVision)).toBe(true);
    expect(creatable.some((type) => PROVIDER_TYPE_SPECS[type].supportsEmbeddings)).toBe(true);
  });

  describe('tierCapabilityRefusal', () => {
    const anthropic = PROVIDER_TYPE_SPECS.anthropic;
    const mistral = PROVIDER_TYPE_SPECS.mistral;

    // The function reports WHICH capability is missing; the sentence an admin
    // reads (which provider, why, what to do instead) is written at the throw
    // site under an error code, so every interface language can render it.
    it('refuses the vision tier on an adapter with no image path', () => {
      expect(tierCapabilityRefusal('vision', anthropic)).toBe('vision_unsupported');
    });

    it('refuses the embeddings tier on a provider with no embeddings API', () => {
      expect(tierCapabilityRefusal('embeddings', anthropic)).toBe('embeddings_unsupported');
    });

    it('permits every tier a provider can actually serve', () => {
      expect(tierCapabilityRefusal('vision', mistral)).toBeNull();
      expect(tierCapabilityRefusal('embeddings', mistral)).toBeNull();
      // Generation tiers are never gated: every adapter completes text.
      expect(tierCapabilityRefusal('answer', anthropic)).toBeNull();
      expect(tierCapabilityRefusal('pipeline', anthropic)).toBeNull();
    });
  });
});

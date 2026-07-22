import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '../../model-gateway/index';
import { dimensionsFor } from './vector-store';

/**
 * embedding_dimensions_cover_presets (issue #177): a configurable embeddings
 * model without an explicit dimensions entry silently fell back to 1024 and
 * failed at upsert. Every embeddings model reachable through a provider
 * preset must map to its real vector size — never the fallback.
 */
describe('embedding_dimensions_cover_presets', () => {
  it('knows the real vector size of the shipped embedding models', () => {
    expect(dimensionsFor('mistral-embed')).toBe(1024);
    expect(dimensionsFor('text-embedding-3-small')).toBe(1536);
    expect(dimensionsFor('text-embedding-3-large')).toBe(3072);
    expect(dimensionsFor('bge-m3')).toBe(1024);
  });

  it('tolerates Ollama :tag suffixes — the dimension belongs to the base model (0041)', () => {
    expect(dimensionsFor('bge-m3:latest')).toBe(1024);
    expect(dimensionsFor('text-embedding-3-large:whatever')).toBe(3072);
  });

  it('every provider preset embeddings model has an EXPLICIT entry (no silent 1024 fallback)', () => {
    // The fallback returns 1024 for anything unknown, so "explicit" means:
    // perturbing the name changes nothing ONLY for genuinely-1024 models —
    // instead, assert each preset model differs from an unknown-name probe
    // unless its real size actually is the default.
    // Genuinely-1024 models are indistinguishable from the fallback by
    // perturbation; they are allowlisted here EXACTLY when their entry exists.
    const genuinely1024 = ['mistral-embed', 'bge-m3'];
    const unknownProbe = dimensionsFor('definitely-not-a-real-model');
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      const model = preset.embedding.model;
      const dims = dimensionsFor(model);
      const explicit = dims !== unknownProbe || genuinely1024.includes(model);
      expect(explicit, `preset ${name}: embeddings model ${model} has no dimensions entry`).toBe(
        true,
      );
    }
  });
});

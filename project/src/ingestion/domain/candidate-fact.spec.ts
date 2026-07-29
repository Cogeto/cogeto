import { describe, expect, it } from 'vitest';
import { extractionOutputSchema, MAX_FACTS_PER_CHUNK } from './candidate-fact';

/**: the extractor's facts array carries a `.max` cap. */
describe('extraction output cap', () => {
  const fact = {
    claim: 'x',
    kind: 'fact',
    entities: { people: [], organizations: [], projects: [] },
    source_span: 'x',
  };

  it('rejects pathological output over the per-chunk fact cap', () => {
    const overCap = { facts: Array.from({ length: MAX_FACTS_PER_CHUNK + 1 }, () => fact) };
    expect(extractionOutputSchema.safeParse(overCap).success).toBe(false);
  });

  it('accepts output at the cap', () => {
    const atCap = { facts: Array.from({ length: MAX_FACTS_PER_CHUNK }, () => fact) };
    expect(extractionOutputSchema.safeParse(atCap).success).toBe(true);
  });
});

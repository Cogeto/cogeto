import { describe, expect, it } from 'vitest';
import type { CandidateFact } from '../domain/candidate-fact';
import { carriesMetadataLabel } from './extract.stage';

/**
 * extract_metadata_guard: a weaker model (especially under redaction, where real
 * names become bracketed slots) can grab one of the extraction input's ALL-CAPS
 * metadata labels — REFERENCE TIME / SOURCE TYPE / SOURCE CONTENT — as if it were
 * content. Such a "fact" is a provenance leak, never grounded in SOURCE CONTENT,
 * and must be dropped before it is stored.
 */

const base: CandidateFact = {
  claim: 'Marko will email the plan to the client.',
  kind: 'commitment',
  entities: { people: ['Marko'], organizations: [], projects: [] },
  condition: null,
  temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
  temporal_expressions: [],
  hedged: false,
  hedge_phrase: null,
  subject_entity: 'Marko',
  source_span: 'Marko will email the plan',
};

describe('extract_metadata_guard', () => {
  it('keeps a normal, grounded fact', () => {
    expect(carriesMetadataLabel(base)).toBe(false);
  });

  it('drops a fact whose subject is a metadata label', () => {
    expect(
      carriesMetadataLabel({
        ...base,
        claim: 'REFERENCE TIME will email the plan.',
        subject_entity: 'REFERENCE TIME',
      }),
    ).toBe(true);
  });

  it('drops a fact whose source_span was pulled from the metadata header', () => {
    expect(
      carriesMetadataLabel({
        ...base,
        source_span: 'REFERENCE TIME (when the source was written)',
      }),
    ).toBe(true);
  });

  it('drops SOURCE TYPE / SOURCE CONTENT leaks too', () => {
    expect(carriesMetadataLabel({ ...base, claim: 'The SOURCE TYPE is user_note.' })).toBe(true);
    expect(carriesMetadataLabel({ ...base, claim: 'SOURCE CONTENT mentions a budget.' })).toBe(
      true,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  isContradictionCandidate,
  isDedupCandidate,
  subjectMatchKind,
} from './reconcile-candidates';
import type { CandidateFacts } from './reconcile-candidates';
import { EntityAliasIndex } from './entity-match';
import { reconcileThresholdsFor } from '../reconcile-config';

/** The candidate gate under the canonical calibration (V2.3 item 6.1). */
const T = reconcileThresholdsFor('mistral-embed');

const fact = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
  kind: 'fact',
  entities: [],
  subjectEntity: 'Adriatic Foods',
  ...over,
});

const ALIASES = new EntityAliasIndex([{ canonical: 'Adriatic Foods', alias: 'Jadranska hrana' }]);

describe('subjectMatchKind', () => {
  it('distinguishes folded, alias, typo and none', () => {
    expect(subjectMatchKind(fact(), fact({ subjectEntity: 'adriatic-foods d.o.o.' }))).toBe(
      'folded',
    );
    expect(subjectMatchKind(fact(), fact({ subjectEntity: 'Jadranska hrana' }), ALIASES)).toBe(
      'alias',
    );
    expect(subjectMatchKind(fact(), fact({ subjectEntity: 'Adriatic Fods' }))).toBe('typo');
    expect(subjectMatchKind(fact(), fact({ subjectEntity: 'Dinara Steel' }))).toBe('none');
    expect(subjectMatchKind(fact(), fact({ subjectEntity: null }))).toBe('none');
  });
});

describe('isContradictionCandidate (v2 gate)', () => {
  it('mid band with folded subjects qualifies, exactly as before', () => {
    expect(isContradictionCandidate(0.85, fact(), fact(), T)).toBe(true);
  });

  it('escalates above the dedup threshold on distinct AND on related', () => {
    expect(isContradictionCandidate(0.95, fact(), fact(), T, 'distinct')).toBe(true);
    // The closed hole: a paraphrased conflict the dedup judge called
    // `related` used to be structurally invisible.
    expect(isContradictionCandidate(0.95, fact(), fact(), T, 'related')).toBe(true);
    expect(isContradictionCandidate(0.95, fact(), fact(), T, null)).toBe(false);
  });

  it('the entity/subject path (null similarity) qualifies on a subject match', () => {
    expect(isContradictionCandidate(null, fact(), fact(), T)).toBe(true);
    expect(isContradictionCandidate(null, fact(), fact({ subjectEntity: 'Dinara Steel' }), T)).toBe(
      false,
    );
  });

  it('below the floor only an ALIAS match carries the pair', () => {
    const low = T.contradictionFloor - 0.1;
    expect(isContradictionCandidate(low, fact(), fact(), T)).toBe(false);
    expect(
      isContradictionCandidate(
        low,
        fact(),
        fact({ subjectEntity: 'Jadranska hrana' }),
        T,
        null,
        ALIASES,
      ),
    ).toBe(true);
  });

  it('kinds still gate: an open loop never contradicts', () => {
    expect(isContradictionCandidate(0.85, fact({ kind: 'open_loop' }), fact(), T)).toBe(false);
    expect(isContradictionCandidate(0.85, fact(), fact({ kind: null }), T)).toBe(false);
  });
});

describe('isDedupCandidate (v2 gate)', () => {
  it('similarity path uses the calibrated threshold', () => {
    expect(isDedupCandidate(T.dedupSimilarity, fact(), fact(), T)).toBe(true);
    expect(isDedupCandidate(T.dedupSimilarity - 0.01, fact(), fact(), T)).toBe(false);
  });

  it('entity path counts alias-equivalent names as overlap', () => {
    const a = fact({ entities: ['Adriatic Foods'] });
    const b = fact({ entities: ['Jadranska hrana'] });
    expect(isDedupCandidate(0.5, a, b, T, ALIASES)).toBe(true);
    expect(isDedupCandidate(0.5, a, b, T)).toBe(false);
  });
});

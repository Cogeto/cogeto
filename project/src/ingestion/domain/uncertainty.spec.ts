import { describe, expect, it } from 'vitest';
import { UNCERTAINTY_REASONS } from '@cogeto/shared';
import type { UncertaintyReason } from '@cogeto/shared';
import { VERIFICATION_VERDICTS } from './candidate-fact';
import type { CandidateFact } from './candidate-fact';
import { classifyAdmission, isUncertaintyReason, structurallyValid } from './uncertainty';
import type { AdmissionSignals } from './uncertainty';

/**
 * The admission taxonomy (V2.0 item 3.3). The whole point of splitting the
 * `uncertain` bucket is that the V2.3 findings report can explain each fact, so
 * the mapping has to be TOTAL: every verification outcome lands on exactly one
 * named sub-reason, with no default arm to hide behind.
 *
 * Pure functions, so this runs without a database, a model, or a container.
 */

const fact = (over: Partial<CandidateFact> = {}): CandidateFact =>
  ({
    claim: 'The workshop is on Tuesday.',
    kind: 'fact',
    entities: { people: [], organizations: [], projects: [] },
    condition: null,
    temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
    temporal_expressions: [],
    hedged: false,
    hedge_phrase: null,
    subject_entity: null,
    source_span: 'workshop is on Tuesday',
    ...over,
  }) as CandidateFact;

/** Every combination of the four signals the classifier reads. */
const allSignals = (): AdmissionSignals[] => {
  const out: AdmissionSignals[] = [];
  for (const verdict of VERIFICATION_VERDICTS) {
    for (const judged of [true, false]) {
      for (const hedged of [true, false]) {
        for (const spanLocatable of [true, false]) {
          out.push({ verdict, judged, hedged, spanLocatable });
        }
      }
    }
  }
  return out;
};

describe('admission taxonomy', () => {
  it('taxonomy_mapping_total: every verification outcome maps to exactly one sub-reason, no fallthrough', () => {
    const combinations = allSignals();
    // 3 verdicts × judged × hedged × spanLocatable — the complete input space.
    expect(combinations).toHaveLength(24);

    for (const signals of combinations) {
      const decision = classifyAdmission(signals);
      const label = JSON.stringify(signals);

      // Exactly one outcome, and the reason column agrees with the status:
      // a reason on an active admission (or its absence on an uncertain one)
      // would be precisely the undifferentiated bucket this replaced.
      if (decision.status === 'active') {
        expect(decision.reason, label).toBeNull();
      } else {
        expect(decision.status, label).toBe('uncertain');
        expect(decision.reason, label).not.toBeNull();
        expect(isUncertaintyReason(decision.reason!), label).toBe(true);
        // Two vocabulary members can never be produced by the classifier:
        // `structurally_invalid` is decided before verification, and
        // `legacy_unspecified` is a backfill value new code never writes.
        expect(decision.reason, label).not.toBe('structurally_invalid');
        expect(decision.reason, label).not.toBe('legacy_unspecified');
      }
    }
  });

  it('taxonomy_mapping_total: the mapping is deterministic and exhaustively pinned', () => {
    // The frozen table, spelled out. If a row here changes, the V2.3 findings
    // report changes with it, so the change belongs in a pull request that says
    // so rather than in a diff nobody reads.
    const expected: [Partial<AdmissionSignals>, 'active' | UncertaintyReason][] = [
      // 1. no verdict returned for the claim wins over everything else
      [
        { verdict: 'unsupported', judged: false, hedged: false, spanLocatable: true },
        'unjudgeable',
      ],
      [{ verdict: 'supported', judged: false, hedged: true, spanLocatable: true }, 'unjudgeable'],
      // 2. supported + hedged: the source was tentative, nothing else is wrong
      [
        { verdict: 'supported', judged: true, hedged: true, spanLocatable: true },
        'hedged_in_source',
      ],
      // 3. supported, plainly stated: ACTIVE
      [{ verdict: 'supported', judged: true, hedged: false, spanLocatable: true }, 'active'],
      // ...including when the chunker could not match the span. Locatability is
      // consulted ONLY on a non-supported verdict, so admission is unchanged
      // from the pre-taxonomy rule and no eval metric can move.
      [{ verdict: 'supported', judged: true, hedged: false, spanLocatable: false }, 'active'],
      // 4. partial
      [
        { verdict: 'partial', judged: true, hedged: false, spanLocatable: true },
        'partially_supported',
      ],
      [{ verdict: 'partial', judged: true, hedged: false, spanLocatable: false }, 'unjudgeable'],
      // verifier failure outranks hedging: a hedged partial is still partial
      [
        { verdict: 'partial', judged: true, hedged: true, spanLocatable: true },
        'partially_supported',
      ],
      // 5. unsupported
      [{ verdict: 'unsupported', judged: true, hedged: false, spanLocatable: true }, 'unsupported'],
      [
        { verdict: 'unsupported', judged: true, hedged: false, spanLocatable: false },
        'unjudgeable',
      ],
      [{ verdict: 'unsupported', judged: true, hedged: true, spanLocatable: true }, 'unsupported'],
    ];

    for (const [signals, outcome] of expected) {
      const decision = classifyAdmission(signals as AdmissionSignals);
      const label = JSON.stringify(signals);
      if (outcome === 'active') {
        expect(decision, label).toEqual({ status: 'active', reason: null });
      } else {
        expect(decision, label).toEqual({ status: 'uncertain', reason: outcome });
      }
    }
  });

  it('taxonomy_mapping_total: admission is byte-identical to the rule it replaced', () => {
    // The pre-taxonomy rule, verbatim: active ONLY when the source stated the
    // claim plainly AND the verifier supported it. Labelling split the uncertain
    // bucket; it did not move the line, and this is the guard that says so.
    for (const signals of allSignals()) {
      const legacyStatus =
        !signals.hedged && signals.verdict === 'supported' && signals.judged
          ? 'active'
          : 'uncertain';
      expect(classifyAdmission(signals).status, JSON.stringify(signals)).toBe(legacyStatus);
    }
  });

  it('the vocabulary is frozen and each value is distinct', () => {
    expect(new Set(UNCERTAINTY_REASONS).size).toBe(UNCERTAINTY_REASONS.length);
    expect(isUncertaintyReason('made_up_reason')).toBe(false);
  });
});

describe('structural validity: the one narrow non-admission', () => {
  it('withholds only a blank claim or a blank span', () => {
    expect(structurallyValid(fact())).toBe(true);
    expect(structurallyValid(fact({ claim: '   ' }))).toBe(false);
    expect(structurallyValid(fact({ source_span: '\n\t ' }))).toBe(false);
  });

  it('never treats an unmatched span as fabrication', () => {
    // A span the chunker cannot locate is NOT structurally invalid. Chunking can
    // split a legitimate span across a boundary, and discarding on that basis
    // would silently lose real facts. It lands `unjudgeable` instead.
    const legitimate = fact({ source_span: 'a span split across two chunks' });
    expect(structurallyValid(legitimate)).toBe(true);
    expect(
      classifyAdmission({
        verdict: 'unsupported',
        judged: true,
        hedged: false,
        spanLocatable: false,
      }),
    ).toEqual({ status: 'uncertain', reason: 'unjudgeable' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildPairInput, deterministicContradiction } from './reconcile.stage';
import type { ReconcileFactView } from './reconcile.stage';

/**
 * The deterministic quantity arm as stage 6 wires it (V2.3 item 6.1, issue
 * C): when it may conclude without a model, when it must escalate, and what
 * the judge input carries when it does.
 */

const view = (content: string, over: Partial<ReconcileFactView> = {}): ReconcileFactView => ({
  content,
  kind: 'fact',
  entities: [],
  subjectEntity: 'VX-9 housing',
  capturedAt: new Date('2026-07-03T10:00:00Z'),
  validFrom: null,
  validUntil: null,
  ...over,
});

describe('deterministicContradiction', () => {
  it('concludes a same-slot numeric conflict with no model call', () => {
    const result = deterministicContradiction(
      view('The VX-9 housing wall thickness is 3.2 mm.'),
      view('The VX-9 housing wall thickness is 3.4 mm.'),
    );
    expect(result.conclusive).toBe(true);
    expect(result.decision.decision).toBe('conflict');
  });

  it('escalates when either side announces a change (supersession territory)', () => {
    const result = deterministicContradiction(
      view('The VX-9 housing wall thickness is now 3.4 mm.'),
      view('The VX-9 housing wall thickness is 3.2 mm.'),
    );
    expect(result.conclusive).toBe(false);
  });

  it('escalates when explicit validity orders the pair', () => {
    const result = deterministicContradiction(
      view('The VX-9 housing wall thickness is 3.4 mm.', {
        validFrom: new Date('2026-06-01T00:00:00Z'),
      }),
      view('The VX-9 housing wall thickness is 3.2 mm.', {
        validFrom: new Date('2026-05-01T00:00:00Z'),
      }),
    );
    expect(result.conclusive).toBe(false);
  });

  it('never concludes on agreement or on anything undecided', () => {
    const agreement = deterministicContradiction(
      view('The PX cable maximum length is 0.5 m.'),
      view('The PX cable maximum length is 50 cm.'),
    );
    expect(agreement.conclusive).toBe(false);
    const wordy = deterministicContradiction(
      view('The kickoff is in Zagreb.'),
      view('The kickoff is in Split.'),
    );
    expect(wordy.conclusive).toBe(false);
  });
});

describe('buildPairInput quantities block', () => {
  it('appends PARSED QUANTITIES only when both sides parse', () => {
    const withBlock = buildPairInput(view('Thickness is 3.2 mm.'), view('Thickness is 3.4 mm.'));
    expect(withBlock).toContain('PARSED QUANTITIES:');
    expect(withBlock).toContain('FACT A: ');
    const without = buildPairInput(view('Thickness is 3.2 mm.'), view('No numbers here.'));
    expect(without).not.toContain('PARSED QUANTITIES');
  });

  it('is byte-identical to the v0001 shape absent quantities', () => {
    const input = buildPairInput(view('Kickoff in Zagreb.'), view('Kickoff in Split.'));
    expect(input.endsWith('entities: (none)\ncaptured: 2026-07-03T10:00:00.000Z')).toBe(true);
  });
});

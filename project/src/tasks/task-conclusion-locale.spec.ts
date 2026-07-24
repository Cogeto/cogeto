import { describe, expect, it } from 'vitest';
import { buildConclusionStatement } from './task-conclusion';

/**
 * Conclusion-memory phrasing in the preferred language (P6.6, decision 0052):
 * still fully deterministic (0037 ruling 4 — no model call), with the
 * connective phrasing following the owner's language and quoted source text
 * kept verbatim.
 */

const base = {
  taskTitle: 'Poslati Ani revidirano mapiranje',
  recordedAt: new Date('2026-07-02T00:00:00Z'),
  concludedAt: new Date('2026-07-14T00:00:00Z'),
};

describe('conclusion phrasing locale', () => {
  it('phrases the connective text in Croatian for an hr owner', () => {
    const statement = buildConclusionStatement({
      ...base,
      type: 'condition_met',
      triggerContent: 'Ana je potvrdila format',
      conditionText: 'čim Ana potvrdi format',
      locale: 'hr',
    });
    expect(statement).toContain('Ana je potvrdila format');
    expect(statement).toContain('time je ispunjen uvjet');
    expect(statement).toContain('zabilježenu 2. srpnja 2026.');
    expect(statement).not.toMatch(/recorded on|satisfied the condition/);
  });

  it('keeps the English phrasing by default', () => {
    const statement = buildConclusionStatement({
      ...base,
      type: 'closed',
      triggerContent: null,
    });
    expect(statement).toBe(
      'The commitment "Poslati Ani revidirano mapiranje" recorded on 2 July 2026 ' +
        'was completed on 14 July 2026.',
    );
  });
});

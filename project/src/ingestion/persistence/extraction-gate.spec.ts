import { describe, expect, it } from 'vitest';
import { evaluateGateDecision } from './extraction-gate.store';

/**
 * The gate predicate (V2.1 item 4.3) — unit surface, pure rows in, decision
 * out. The database plumbing around it is covered by the pipeline integration
 * spec; these pin the RULE SEMANTICS, the way the first-person rule's
 * predicate was pinned.
 */

const input = { sourceId: 'src-1', documentClass: undefined as string | undefined };

describe('extraction_gate_decision', () => {
  it('no gate row and no rules is exactly today: allowed, defaults untouched', () => {
    expect(evaluateGateDecision(undefined, [], input)).toEqual({
      allowed: true,
      factBudget: null,
      retentionDays: null,
    });
  });

  it('a disabled gate refuses everything on that source type', () => {
    const decision = evaluateGateDecision(
      { enabled: false, factBudget: null, retentionDays: null },
      [],
      input,
    );
    expect(decision).toEqual({ allowed: false, reason: 'extraction_disabled' });
  });

  it('an enabled gate passes its budget and retention through', () => {
    expect(
      evaluateGateDecision({ enabled: true, factBudget: 5, retentionDays: 30 }, [], input),
    ).toEqual({ allowed: true, factBudget: 5, retentionDays: 30 });
  });

  it('a source_id deny rule switches off exactly that source', () => {
    const rules = [{ dimension: 'source_id', value: 'src-1', effect: 'deny' as const }];
    expect(evaluateGateDecision(undefined, rules, input)).toEqual({
      allowed: false,
      reason: 'source_disabled',
    });
    expect(evaluateGateDecision(undefined, rules, { ...input, sourceId: 'src-2' })).toMatchObject({
      allowed: true,
    });
  });

  it('a document_class deny rule blocks that class and no other', () => {
    const rules = [{ dimension: 'document_class', value: 'image', effect: 'deny' as const }];
    expect(evaluateGateDecision(undefined, rules, { ...input, documentClass: 'image' })).toEqual({
      allowed: false,
      reason: 'document_class_denied',
      documentClass: 'image',
    });
    expect(
      evaluateGateDecision(undefined, rules, { ...input, documentClass: 'pdf' }),
    ).toMatchObject({ allowed: true });
  });

  it('allow rules make the class list exclusive (the email-allowlist semantics)', () => {
    const rules = [{ dimension: 'document_class', value: 'pdf', effect: 'allow' as const }];
    expect(
      evaluateGateDecision(undefined, rules, { ...input, documentClass: 'pdf' }),
    ).toMatchObject({ allowed: true });
    expect(evaluateGateDecision(undefined, rules, { ...input, documentClass: 'xlsx' })).toEqual({
      allowed: false,
      reason: 'document_class_denied',
      documentClass: 'xlsx',
    });
  });

  it('class rules never touch a source with no detected class (notes, chat, email, web)', () => {
    const rules = [
      { dimension: 'document_class', value: 'pdf', effect: 'allow' as const },
      { dimension: 'document_class', value: 'image', effect: 'deny' as const },
    ];
    expect(evaluateGateDecision(undefined, rules, input)).toMatchObject({ allowed: true });
  });

  it('deny wins even when the class is also allowed', () => {
    const rules = [
      { dimension: 'document_class', value: 'pdf', effect: 'allow' as const },
      { dimension: 'document_class', value: 'pdf', effect: 'deny' as const },
    ];
    expect(
      evaluateGateDecision(undefined, rules, { ...input, documentClass: 'pdf' }),
    ).toMatchObject({ allowed: false, reason: 'document_class_denied' });
  });

  it('disabled outranks every rule: the broadest refusal is reported', () => {
    const rules = [{ dimension: 'source_id', value: 'src-1', effect: 'deny' as const }];
    expect(
      evaluateGateDecision({ enabled: false, factBudget: null, retentionDays: null }, rules, input),
    ).toEqual({ allowed: false, reason: 'extraction_disabled' });
  });
});

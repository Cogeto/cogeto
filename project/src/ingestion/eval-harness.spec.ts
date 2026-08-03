import { describe, expect, it } from 'vitest';
import { assertVerificationDeclarable } from './eval-harness';

/**
 * The guard that makes an unwinnable corpus case unrepresentable.
 *
 * Three Croatian cases declared `verification_expected: "supported"` with no
 * expected memories. Verification agreement for `supported` is scored over the
 * facts that MATCHED a label, so with no labels those cases were counted as
 * disagreeing on every run, forever, whatever the system did. Each cost the
 * language a permanent point of agreement, which is how the hr floor came to
 * sit one case away from red and then went red on main.
 *
 * Fixing the three files would have fixed the number. This test is here so the
 * mistake cannot come back: it is checked when the corpus loads, so a case that
 * asserts something unreachable fails the run loudly instead of quietly
 * dragging a language's score down for months.
 */
describe('verification_expected must be reachable', () => {
  const label = (must: boolean) => ({ must_extract: must });

  it('refuses `supported` on a case with no expected memories', () => {
    expect(() =>
      assertVerificationDeclarable({
        case_id: 'hr-0023',
        expected_memories: [],
        verification_expected: 'supported',
      }),
    ).toThrow(/unreachable with no expected memories/);
  });

  it('refuses `partial` on a case with no expected memories', () => {
    expect(() =>
      assertVerificationDeclarable({
        case_id: 'xx-0001',
        expected_memories: [],
        verification_expected: 'partial',
      }),
    ).toThrow(/unreachable/);
  });

  it('allows the trap rule, which is exactly what a remember-nothing case wants', () => {
    expect(() =>
      assertVerificationDeclarable({
        case_id: 'hr-0027',
        expected_memories: [],
        verification_expected: 'unsupported',
      }),
    ).not.toThrow();
  });

  it('allows omitting the field: the case simply does not measure verification', () => {
    expect(() =>
      assertVerificationDeclarable({ case_id: 'en-0005', expected_memories: [] }),
    ).not.toThrow();
  });

  it('allows `supported` as soon as a label exists that could match', () => {
    // A `must_extract: false` label can still match, so the case is winnable.
    expect(() =>
      assertVerificationDeclarable({
        case_id: 'en-i002',
        expected_memories: [label(false)],
        verification_expected: 'supported',
      }),
    ).not.toThrow();
  });
});

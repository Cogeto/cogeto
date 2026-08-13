import { describe, expect, it } from 'vitest';
import { chooseSurvivor, KeepHintError, partitionPlans, planFor } from './dedupe-plan';
import type { DuplicateCopy } from './dedupe-plan';

/**
 * Which copy of a duplicated file survives (issue #538).
 *
 * Every case here is a shape taken from the real instance the cleanup was
 * written for, because the plausible rule and the correct rule differ on all
 * of them:
 *
 *   oldest_is_not_the_rule — the four oldest copies of one document held zero
 *     facts, their pipeline runs having failed. Keeping the oldest, which is
 *     how NEW uploads resolve, would have deleted every fact it produced.
 *   richest_wins_because_extraction_is_not_bit_stable — two copies of the same
 *     bytes yielded 88 facts and 109.
 *   citation_outranks_facts — a deleted memory takes any stored answer citing
 *     it with it, so the copy answers point at is the one that stays.
 *   both_cited_is_held_back — when both copies are cited no survivor choice
 *     saves every answer, and that is a decision for a person.
 *   choice_is_deterministic — same input, same survivor, whatever the order.
 */

const copy = (over: Partial<DuplicateCopy> & { objectKey: string }): DuplicateCopy => ({
  ownerId: 'user-a',
  facts: 0,
  citedByAnswers: 0,
  uploadDate: new Date('2026-08-03T10:00:00Z'),
  ...over,
});

const group = (copies: DuplicateCopy[]) => ({
  checksum: 'abc123',
  scope: 'private',
  sensitive: false,
  copies,
});

describe('choosing which duplicate survives', () => {
  it('oldest_is_not_the_rule: an empty original never outranks a copy that extracted', () => {
    // The real shape: six uploads of one document, the four oldest empty.
    const copies = [
      copy({ objectKey: 'k/b36abfb85892', uploadDate: new Date('2026-08-03T09:00:00Z') }),
      copy({ objectKey: 'k/02aee3a35cb6', uploadDate: new Date('2026-08-03T09:10:00Z') }),
      copy({ objectKey: 'k/bbfe20fc2b5f', uploadDate: new Date('2026-08-03T09:20:00Z') }),
      copy({ objectKey: 'k/c3d4cd4a6e53', uploadDate: new Date('2026-08-03T09:30:00Z') }),
      copy({ objectKey: 'k/dbe340d22db6', uploadDate: new Date('2026-08-03T09:40:00Z'), facts: 3 }),
      copy({ objectKey: 'k/45628f0487fd', uploadDate: new Date('2026-08-06T09:00:00Z'), facts: 3 }),
    ];
    const plan = planFor(group(copies));
    // Not `b36abfb85892`, which is what "keep the oldest" would have said and
    // would have left the document with nothing.
    expect(plan.keep.objectKey).toBe('k/dbe340d22db6');
    expect(plan.remove).toHaveLength(5);
    // Of the five removed, only one carried facts; the four empties are pure
    // clutter, which is the whole reason this is worth doing.
    expect(plan.remove.reduce((n, c) => n + c.facts, 0)).toBe(3);
  });

  it('richest_wins_because_extraction_is_not_bit_stable', () => {
    const lean = copy({ objectKey: 'k/927a6f1422df', facts: 88 });
    const rich = copy({
      objectKey: 'k/1656081e76a8',
      facts: 109,
      uploadDate: new Date('2026-08-11T12:00:00Z'),
    });
    // Same bytes, different harvest. The later, richer copy wins despite being
    // younger: the count is evidence about the extraction, not about the file.
    expect(chooseSurvivor([lean, rich]).objectKey).toBe('k/1656081e76a8');
  });

  it('citation_outranks_facts: the copy answers point at is the one that stays', () => {
    const cited = copy({ objectKey: 'k/cited', facts: 3, citedByAnswers: 1 });
    const richer = copy({ objectKey: 'k/richer', facts: 40 });
    // Losing 37 facts that are still derivable from identical bytes costs
    // less than breaking an answer a user already read and trusted.
    expect(chooseSurvivor([richer, cited]).objectKey).toBe('k/cited');
    expect(planFor(group([richer, cited])).answersRedacted).toBe(0);
  });

  it('both_cited_is_held_back: no survivor choice saves every answer there', () => {
    const a = copy({ objectKey: 'k/a', facts: 88, citedByAnswers: 3 });
    const b = copy({ objectKey: 'k/b', facts: 109, citedByAnswers: 2 });
    const plan = planFor(group([a, b]));
    // Whichever is kept, answers citing the other are redacted wholesale.
    expect(plan.answersRedacted).toBeGreaterThan(0);

    const { safe, held } = partitionPlans([plan], false);
    expect(safe).toEqual([]);
    expect(held).toEqual([plan]);

    // The operator can still choose to pay it, having been shown the cost.
    expect(partitionPlans([plan], true).safe).toEqual([plan]);
  });

  it('a_group_whose_citations_all_sit_on_the_survivor_is_free_to_tidy', () => {
    const keep = copy({ objectKey: 'k/keep', facts: 3, citedByAnswers: 2 });
    const drop = copy({ objectKey: 'k/drop', facts: 3 });
    const plan = planFor(group([keep, drop]));
    expect(plan.answersRedacted).toBe(0);
    expect(partitionPlans([plan], false).safe).toEqual([plan]);
  });

  it('choice_is_deterministic whatever order the rows arrive in', () => {
    const copies = [
      copy({ objectKey: 'k/aaa', facts: 5 }),
      copy({ objectKey: 'k/bbb', facts: 5 }),
      copy({ objectKey: 'k/ccc', facts: 5 }),
    ];
    const first = chooseSurvivor(copies).objectKey;
    expect(chooseSurvivor([...copies].reverse()).objectKey).toBe(first);
    // Fully tied on every signal, so the key breaks it rather than the order
    // the database happened to return.
    expect(first).toBe('k/aaa');
  });

  it('keep_names_the_survivor, overriding the rule and releasing the hold', () => {
    // The real case the flag exists for: both copies cited, so the tool holds
    // the group back and its own choice (most-cited, 3 beats 2) is the one it
    // just admitted it could not make well. The operator names the other.
    const cited = copy({ objectKey: 'k/927a6f1422df', facts: 88, citedByAnswers: 3 });
    const rich = copy({ objectKey: 'k/1656081e76a8', facts: 109, citedByAnswers: 2 });

    expect(planFor(group([cited, rich])).keep.objectKey).toBe('k/927a6f1422df');

    const named = planFor(group([cited, rich]), ['1656081e76a8']);
    expect(named.keep.objectKey).toBe('k/1656081e76a8');
    expect(named.remove.map((c) => c.objectKey)).toEqual(['k/927a6f1422df']);
    expect(named.chosenByOperator).toBe(true);
    // The cost does not disappear, it is accepted: three answers still go.
    expect(named.answersRedacted).toBe(3);
    // And the group runs WITHOUT the blanket flag, because naming a survivor
    // is the per-group form of the same decision.
    expect(partitionPlans([named], false).safe).toEqual([named]);
  });

  it('keep_that_matches_nothing_here leaves the rule in charge', () => {
    const a = copy({ objectKey: 'k/aaa', facts: 9 });
    const b = copy({ objectKey: 'k/bbb', facts: 2 });
    // A hint for a DIFFERENT group must not silently alter this one.
    const plan = planFor(group([a, b]), ['zzz']);
    expect(plan.keep.objectKey).toBe('k/aaa');
    expect(plan.chosenByOperator).toBe(false);
  });

  it('keep_that_matches_two_copies is refused, never guessed', () => {
    // Choosing between two things the operator did not distinguish is exactly
    // how the wrong document gets deleted.
    const a = copy({ objectKey: 'k/one-tail' });
    const b = copy({ objectKey: 'k/two-tail' });
    expect(() => planFor(group([a, b]), ['tail'])).toThrow(KeepHintError);
  });

  it('never_removes_the_survivor: remove is exactly the rest of the group', () => {
    const copies = [
      copy({ objectKey: 'k/one', facts: 2 }),
      copy({ objectKey: 'k/two', facts: 9 }),
      copy({ objectKey: 'k/three' }),
    ];
    const plan = planFor(group(copies));
    expect(plan.remove.map((c) => c.objectKey)).not.toContain(plan.keep.objectKey);
    expect(plan.remove).toHaveLength(copies.length - 1);
  });
});

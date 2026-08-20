import { sql } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';

/**
 * The decision half of `dedupe-file-sources` (issue #538), separated so it can
 * be tested as what it is. The same shape `eval-env.ts` has next to the eval
 * harnesses.
 *
 * Everything here decides WHICH copy of a duplicated file survives and whether
 * a group may be touched at all: the query that gathers the evidence, and the
 * pure rules over it. The command performs; this chooses.
 */

/** One stored upload of some bytes, with the two things that decide its fate. */
export interface DuplicateCopy {
  objectKey: string;
  ownerId: string;
  /** The copy's space: dedup groups per space, and the deleting principal
   * must stand in the copy's own space (docs/features/spaces.md). */
  spaceId: string;
  /** Memories whose provenance is this copy. Deleting it deletes them. */
  facts: number;
  /** Stored answers citing at least one of those memories. */
  citedByAnswers: number;
  uploadDate: Date;
}

export interface DuplicateGroup {
  checksum: string;
  scope: string;
  sensitive: boolean;
  copies: DuplicateCopy[];
}

export interface DuplicatePlan {
  group: DuplicateGroup;
  keep: DuplicateCopy;
  remove: DuplicateCopy[];
  /**
   * Answers that cite a fact this plan would delete. The redaction cascade
   * replaces such an answer wholesale with "This answer referenced information
   * that has since been deleted", so a non-zero count means the tidying would
   * cost a stored answer.
   */
  answersRedacted: number;
  /**
   * The survivor was NAMED by the operator rather than derived. A held-back
   * group is precisely one the tool refuses to decide, so naming a survivor is
   * the decision it was waiting for, and the group stops being held back.
   */
  chosenByOperator: boolean;
}

/** A `--keep` value that does not identify exactly one copy. */
export class KeepHintError extends Error {}

/**
 * Which copy survives.
 *
 * The obvious rule, "keep the oldest", is what `findStoredDuplicate` uses to
 * route new uploads, and it is wrong for cleanup. Measured on a real instance:
 * one group of six copies had the four OLDEST holding zero facts, their
 * pipeline runs having failed, so keeping the oldest would have deleted every
 * fact the document ever produced. Extraction is not bit-stable either: two
 * copies of the same bytes yielded 88 facts and 109.
 *
 * The sharper constraint is citation. A deleted memory takes any stored answer
 * citing it along with it. An answer whose citations no longer resolve is the
 * one thing this product must not quietly produce, so the most-cited copy wins
 * first, then the richest, then the oldest, with the key as a final
 * tie-break so the choice is deterministic.
 *
 * Survivor choice is free with respect to future uploads: once a group has one
 * row left, `findStoredDuplicate` returns it whichever one it is.
 */
export function chooseSurvivor(copies: readonly DuplicateCopy[]): DuplicateCopy {
  return [...copies].sort(
    (a, b) =>
      b.citedByAnswers - a.citedByAnswers ||
      b.facts - a.facts ||
      a.uploadDate.getTime() - b.uploadDate.getTime() ||
      a.objectKey.localeCompare(b.objectKey),
  )[0]!;
}

/**
 * The plan for one group, optionally with the survivor NAMED by the operator.
 *
 * The tool holds back any group it cannot tidy without breaking a stored
 * answer, which is right, but on its own that left the operator with only the
 * tool's own choice to accept or refuse, and the tool's choice is the one it
 * just said it could not make well. `keepHints` is how the decision the report
 * asks for gets recorded: each hint matches the END of an object key, so the
 * twelve characters the report prints are enough to name a copy.
 *
 * A hint matching no copy in this group is simply not this group's hint. A hint
 * matching SEVERAL is refused rather than guessed, because choosing between two
 * things the operator did not distinguish is how the wrong document gets
 * deleted.
 */
export function planFor(group: DuplicateGroup, keepHints: readonly string[] = []): DuplicatePlan {
  const named = group.copies.filter((copy) =>
    keepHints.some((hint) => copy.objectKey.endsWith(hint)),
  );
  if (named.length > 1) {
    throw new KeepHintError(
      `--keep matches ${named.length} copies in group ${group.checksum.slice(0, 8)}: ` +
        `${named.map((copy) => copy.objectKey).join(', ')}. Name one of them exactly.`,
    );
  }
  const keep = named[0] ?? chooseSurvivor(group.copies);
  const remove = group.copies.filter((copy) => copy.objectKey !== keep.objectKey);
  return {
    group,
    keep,
    remove,
    answersRedacted: remove.reduce((total, copy) => total + copy.citedByAnswers, 0),
    chosenByOperator: named.length === 1,
  };
}

/**
 * Splits the plans into the ones that may run and the ones a human must
 * decide.
 *
 * A group where every citation sits on the survivor is free to tidy. A group
 * where BOTH copies are cited cannot be tidied without losing an answer, and
 * no survivor choice changes that, so it is held back and reported rather than
 * traded away silently. `allowRedaction` is the operator saying they have read
 * the report and accept the cost across the board; naming a survivor with
 * `--keep` says it for one group, which is the narrower and usually better
 * answer.
 */
export function partitionPlans(
  plans: readonly DuplicatePlan[],
  allowRedaction: boolean,
): { safe: DuplicatePlan[]; held: DuplicatePlan[] } {
  const safe: DuplicatePlan[] = [];
  const held: DuplicatePlan[] = [];
  for (const plan of plans) {
    // An operator who named the survivor has made exactly the decision the
    // hold-back exists to demand, so that group runs without the blanket flag.
    if (plan.answersRedacted === 0 || plan.chosenByOperator || allowRedaction) safe.push(plan);
    else held.push(plan);
  }
  return { safe, held };
}

export async function loadDuplicateGroups(db: Db): Promise<DuplicateGroup[]> {
  // Grouped by (owner, checksum, scope, sensitive), which is EXACTLY the
  // going-forward rule from #536: a scope or sensitive difference is
  // deliberately not a duplicate there, because a private original cannot
  // answer a request for a shared one. Cleanup must not collapse what upload
  // keeps apart, or the two rules would disagree about what a duplicate is.
  // A NULL checksum (discard mode writes no row at all; older rows may
  // predate it) never groups: `=` on NULL is never true.
  const { rows } = await db.execute<{
    object_key: string;
    owner_id: string;
    space_id: string;
    checksum: string;
    scope: string;
    sensitive: boolean;
    upload_date: Date;
    facts: number;
    cited: number;
  }>(sql`
    WITH duplicated AS (
      -- space_id in the grouping key (docs/features/spaces.md): dedup is PER
      -- SPACE by design, so the same file uploaded into two spaces is two
      -- independent sources and NEVER a duplicate pair this plan may collapse.
      SELECT owner_id, space_id, checksum, scope, sensitive
        FROM file_metadata
       WHERE checksum IS NOT NULL
       GROUP BY 1, 2, 3, 4, 5
      HAVING count(*) > 1
    )
    SELECT f.object_key, f.owner_id, f.space_id, f.checksum, f.scope::text AS scope,
           f.sensitive, f.upload_date,
           (SELECT count(*)::int FROM memory m
             WHERE m.source_type = 'file' AND m.source_id = f.object_key) AS facts,
           (SELECT count(DISTINCT c.id)::int
              FROM chat_message c
              JOIN memory m ON m.source_type = 'file' AND m.source_id = f.object_key
             WHERE c.role = 'assistant'
               AND c.content LIKE '%{{cite:' || m.id || '}}%') AS cited
      FROM file_metadata f
      JOIN duplicated d
        ON d.owner_id = f.owner_id AND d.space_id = f.space_id AND d.checksum = f.checksum
       AND d.scope = f.scope AND d.sensitive = f.sensitive
     ORDER BY f.owner_id, f.checksum, f.upload_date, f.object_key
  `);

  const byGroup = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.owner_id,
      row.space_id,
      row.checksum,
      row.scope,
      row.sensitive,
    ]);
    const group = byGroup.get(key) ?? {
      checksum: row.checksum,
      scope: row.scope,
      sensitive: row.sensitive,
      copies: [],
    };
    group.copies.push({
      objectKey: row.object_key,
      ownerId: row.owner_id,
      spaceId: row.space_id,
      facts: Number(row.facts),
      citedByAnswers: Number(row.cited),
      uploadDate: new Date(row.upload_date),
    });
    byGroup.set(key, group);
  }
  return [...byGroup.values()];
}

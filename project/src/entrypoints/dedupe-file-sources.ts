import { NestFactory } from '@nestjs/core';
import type { Principal } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { DeletionExecutor, DeletionSaga } from '../memory/index';
import { loadConfig } from './config';
import { loadDuplicateGroups, partitionPlans, planFor } from './dedupe-plan';
import type { DuplicateCopy } from './dedupe-plan';
import { installModelConfiguration } from './model-boot';
import { createWorkerRootModule } from './worker-root.module';

/**
 * dedupe-file-sources — remove the duplicate file sources that predate the
 * upload deduplication of issue #536 (issue #538).
 *
 * #536 stopped NEW duplicates: the same bytes uploaded twice now resolve to
 * the source that already holds them. An instance that predates it still
 * holds the copies it would have prevented, each with its own extracted,
 * verified and embedded facts, and each entering reconciliation as a
 * candidate against its own twin.
 *
 * Removing them is a DELETION, not a migration. Those facts are real
 * memories, so they go the only way memories ever go: through the deletion
 * saga, one enumeration transaction per source, a signed receipt each, every
 * registered cascade run, Qdrant points and MinIO objects removed, receipt
 * confirmed. Afterwards the erasure is provable exactly like a user's own.
 * That is also why this builds the WORKER root rather than a hand-rolled
 * module: the worker root registers all fifteen derived cascades, and a root
 * that registered fewer would write a receipt claiming an erasure it had not
 * performed.
 *
 * DRY RUN BY DEFAULT. It prints the plan and changes nothing until `--apply`.
 * Idempotent: a second run has nothing left to remove and exits 0. Held-back
 * groups keep reporting themselves, which is the point of holding them back.
 */

/**
 * The object key contract is `{orgId}/{userId}/{scope}/file-{uuid}`, so the
 * principal the saga acts as is derivable from the key itself. Only `userId`
 * (authorization, audit, passport expiry) and `orgId` (audit stamping) are
 * read.
 */
function principalFor(copy: DuplicateCopy): Principal {
  return {
    userId: copy.ownerId,
    name: '',
    email: null,
    orgId: copy.objectKey.split('/')[0] ?? '',
    orgName: '',
    roles: [],
  };
}

/** Short enough to read in a terminal, long enough to identify the row. */
const short = (key: string): string => key.slice(-12);

function parseArgs(argv: string[]): { apply: boolean; allowRedaction: boolean } {
  const out = { apply: false, allowRedaction: false };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--allow-redaction') out.allowRedaction = true;
    else {
      console.error(`unknown argument: ${arg}`);
      console.error('usage: dedupe-file-sources [--apply] [--allow-redaction]');
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { apply, allowRedaction } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  // The DATABASE's model configuration is what this instance runs (V2.4 item
  // 7.1). The saga touches the vector store, so the embedding space this
  // resolves must be the live one.
  const live = await installModelConfiguration(config);

  const context = await NestFactory.createApplicationContext(
    createWorkerRootModule(config, live) as never,
    { abortOnError: false, logger: ['error'] },
  );
  const db = context.get<Db>(DRIZZLE);
  const saga = context.get(DeletionSaga);
  const executor = context.get(DeletionExecutor);

  try {
    const plans = (await loadDuplicateGroups(db)).map(planFor);
    if (plans.length === 0) {
      console.log(
        'nothing to do: no file source has a duplicate under (owner, checksum, scope, sensitive)',
      );
      return;
    }

    // A group whose deletion would redact an answer is held back rather than
    // traded away silently. Sometimes BOTH copies are cited, in which case no
    // survivor choice saves every answer and only a human can decide whether
    // the tidiness is worth the answer.
    const { safe, held } = partitionPlans(plans, allowRedaction);

    console.log(`${plans.length} duplicate group(s):\n`);
    for (const plan of plans) {
      const heldBack = held.includes(plan);
      console.log(
        `  ${plan.group.checksum.slice(0, 8)}  ${plan.group.scope}` +
          `${plan.group.sensitive ? ' sensitive' : ''}` +
          `${heldBack ? '   HELD BACK' : ''}`,
      );
      for (const copy of plan.group.copies) {
        const keeping = copy.objectKey === plan.keep.objectKey;
        console.log(
          `    ${keeping ? 'keep  ' : 'remove'} ${short(copy.objectKey)}  ` +
            `${String(copy.facts).padStart(4)} fact(s)  ` +
            `${copy.citedByAnswers} answer(s) cite it  ` +
            `${copy.uploadDate.toISOString().slice(0, 10)}`,
        );
      }
      if (heldBack) {
        console.log(
          `    → removing these would redact ${plan.answersRedacted} stored answer(s), ` +
            'so this group is left alone. Pass --allow-redaction to include it.',
        );
      }
      console.log('');
    }

    const removals = safe.flatMap((plan) => plan.remove);
    const facts = removals.reduce((total, copy) => total + copy.facts, 0);
    console.log(
      `${apply ? 'REMOVING' : 'WOULD REMOVE'} ${removals.length} source(s) ` +
        `carrying ${facts} fact(s); ${held.length} group(s) held back.`,
    );
    if (!apply) {
      console.log('\nDRY RUN. Nothing was changed. Re-run with --apply to perform the deletions.');
      return;
    }

    let confirmed = 0;
    for (const copy of removals) {
      const principal = principalFor(copy);
      const { receiptId } = await saga.requestSourceDeletion(principal, 'file', copy.objectKey);
      // The saga returns null when nothing erasable derived from the source
      // (SEC-30). A copy with zero facts and no stored object legitimately
      // reaches that state: report it rather than confirming a receipt that
      // does not exist.
      if (receiptId === null) {
        console.log(`  ${short(copy.objectKey)} → nothing erasable, no receipt`);
        continue;
      }
      // The external leg runs inline rather than staying queued: this command
      // IS the operation, and its report should describe finished work.
      const result = await db.transaction((tx) => executor.execute(tx, receiptId));
      confirmed += 1;
      console.log(
        `  ${short(copy.objectKey)} → receipt ${receiptId} confirmed ` +
          `(${result.points} point(s), ${result.objects} object(s))`,
      );
    }
    console.log(`\ndone: ${confirmed} receipt(s) confirmed.`);
    if (held.length > 0) {
      console.log(
        `${held.length} group(s) left alone because removing a copy would redact a stored answer.`,
      );
    }
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  // `process.exit` immediately after a write can truncate it when stdout is a
  // pipe (docker exec, CI): set the code and let the process end on its own.
  console.error(
    `dedupe-file-sources FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});

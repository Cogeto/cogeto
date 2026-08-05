import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { IngestionStage } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import { ingestionProgress } from './tables';

/**
 * The honest per-source pipeline stage (V2.2 item 5.1, migration 0045).
 *
 * A pipeline run holds one transaction from reading to reconciliation, so
 * "processing" was the only truthful thing a surface could say about it.
 * This store gives a run's stages an observable form: the pipeline reports
 * each stage it enters, the row is upserted on its OWN connection (the
 * file_read_report precedent: a stage written inside the job transaction
 * would vanish with the failure it should explain), and any surface reads it
 * back beside the queue's terminal state. Metadata only: source identifiers
 * and a stage name, never content.
 *
 * A write must never become a way for the pipeline to fail: report() swallows
 * its own errors. An absent store (bare harnesses, eval) means no stage rows
 * and byte-identical pipeline behaviour.
 */
@Injectable()
export class IngestionProgressStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Records the stage a source's run just entered. Never throws. */
  async report(
    ref: { sourceType: string; sourceId: string },
    stage: IngestionStage,
    logger?: { warn(message: string): void },
  ): Promise<void> {
    try {
      await this.db
        .insert(ingestionProgress)
        .values({
          sourceType: ref.sourceType,
          sourceId: ref.sourceId,
          stage,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [ingestionProgress.sourceType, ingestionProgress.sourceId],
          set: { stage, updatedAt: new Date() },
        });
    } catch (error) {
      logger?.warn(
        `could not record pipeline progress for ${ref.sourceType}/${ref.sourceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Deletion-cascade leg: the stage rows for these sources. Returns the count. */
  async deleteForSources(
    tx: DbOrTx,
    refs: { sourceType: string; sourceId: string }[],
  ): Promise<number> {
    let removed = 0;
    for (const ref of refs) {
      const rows = await tx
        .delete(ingestionProgress)
        .where(
          and(
            eq(ingestionProgress.sourceType, ref.sourceType),
            eq(ingestionProgress.sourceId, ref.sourceId),
          ),
        )
        .returning({ sourceId: ingestionProgress.sourceId });
      removed += rows.length;
    }
    return removed;
  }
}

/**
 * The read side, as a plain function over any handle (the jobRunState shape):
 * the surfaces that render progress (chat attachments, the Sources upload
 * rows) live in other modules and must not name this table.
 */
export async function pipelineStageFor(
  db: DbOrTx,
  ref: { sourceType: string; sourceId: string },
): Promise<IngestionStage | null> {
  const rows = await db
    .select({ stage: ingestionProgress.stage })
    .from(ingestionProgress)
    .where(
      and(
        eq(ingestionProgress.sourceType, ref.sourceType),
        eq(ingestionProgress.sourceId, ref.sourceId),
      ),
    )
    .limit(1);
  const stage = rows[0]?.stage;
  return stage === 'reading' ||
    stage === 'extracting' ||
    stage === 'verifying' ||
    stage === 'storing'
    ? stage
    : null;
}

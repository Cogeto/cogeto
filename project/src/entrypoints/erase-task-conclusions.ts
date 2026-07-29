import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { DatabaseModule, DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { PipelineIngestionGuard } from '../ingestion/index';
import { DeletionExecutor, DeletionSaga, MemoryModule } from '../memory/index';
import type { SourceDeletion } from '../memory/index';
import { loadConfig } from './config';

/**
 * erase-task-conclusions — the one-shot that MUST run before migration 0035
 *.
 *
 * `task_conclusion` memories carry provenance pointing at `task_conclusion`
 * rows. Dropping that table with the memories still present
 * would strand their §A.6 provenance and trip the integrity sweep's orphan arm
 *. So the memories are erased the only way memories are ever
 * erased: THROUGH the deletion saga — one enumeration transaction per source,
 * a signed receipt each, Qdrant points and MinIO objects removed, receipt
 * confirmed. The erasure is provable afterwards, exactly like a user's own.
 *
 * Migration 0035 refuses to drop the table while any such memory remains, so
 * skipping this step fails loudly at migrate time rather than silently later.
 *
 * Idempotent: a second run finds no sources and does nothing. Safe on an
 * instance that never had tasks (the overwhelmingly common case) — it reports
 * "nothing to erase" and exits 0.
 */

/**
 * The last surviving piece of task_conclusion knowledge, kept here in the
 * composition root rather than in a module: the saga needs a SourceDeletion
 * adapter to authorize and to remove the source row, and the module that used
 * to provide one is gone. Raw SQL is deliberate and permitted here (§A.1 —
 * entrypoints are the composition root); the table itself disappears with the
 * next migration.
 */
@Injectable()
class TaskConclusionEraseAdapter implements SourceDeletion {
  readonly sourceType = 'task_conclusion' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    const { rows } = await tx.execute<{ owner_id: string }>(
      sql`SELECT owner_id FROM task_conclusion WHERE id = ${sourceId}::uuid FOR UPDATE`,
    );
    return rows[0]?.owner_id ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.execute(sql`DELETE FROM task_conclusion WHERE id = ${sourceId}::uuid`);
  }
}

/**
 * The adapter's own module — the saga resolves SOURCE_DELETIONS inside
 * MemoryModule's injector, so an adapter must reach it through an imported
 * module, exactly like the connector adapters do.
 */
@Module({ providers: [TaskConclusionEraseAdapter], exports: [TaskConclusionEraseAdapter] })
class TaskConclusionEraseModule {}

async function main(): Promise<void> {
  const config = loadConfig();

  @Module({
    imports: [
      DatabaseModule.register({ databaseUrl: config.databaseUrl, poolMax: config.pgPoolMax }),
      // This script serves no HTTP, but MemoryModule carries controllers whose
      // guards Nest resolves at init — the same reason the worker root registers
      // the identity seam.
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        cacheTtlSeconds: 10,
      }),
      MemoryModule.register({
        qdrantUrl: config.qdrantUrl,
        qdrantApiKey: config.qdrantApiKey,
        embeddingModel: config.modelProviders.tiers.embedding.model,
        s3: {
          url: config.s3Url,
          publicUrl: config.s3PublicUrl,
          accessKey: config.s3AccessKey,
          secretKey: config.s3SecretKey,
          bucket: config.s3Bucket,
        },
        instanceKeyDir: config.instanceKeyDir,
        sourceDeletions: {
          imports: [TaskConclusionEraseModule],
          adapters: [TaskConclusionEraseAdapter],
        },
        ingestionGuard: PipelineIngestionGuard,
      }),
    ],
  })
  class Root {}

  // abortOnError:false — Nest's default is to log-and-abort the PROCESS on an
  // init failure, which with a silenced logger exits 1 with no message at all.
  const context = await NestFactory.createApplicationContext(Root, {
    abortOnError: false,
    logger: ['error'],
  });
  const db = context.get<Db>(DRIZZLE);
  const saga = context.get(DeletionSaga);
  const executor = context.get(DeletionExecutor);

  try {
    // Every distinct task_conclusion source that still has memories, with the
    // owner the saga will act as (memories are single-owner by construction).
    const { rows } = await db.execute<{ source_id: string; owner_id: string }>(sql`
      SELECT DISTINCT source_id, owner_id
        FROM memory
       WHERE source_type = 'task_conclusion'
       ORDER BY source_id
    `);
    if (rows.length === 0) {
      console.log('nothing to erase: no memories carry task_conclusion provenance');
      return;
    }
    console.log(`erasing ${rows.length} task_conclusion source(s) through the deletion saga…`);

    let confirmed = 0;
    for (const row of rows) {
      const principal: Principal = {
        userId: row.owner_id,
        name: '',
        email: null,
        orgId: '',
        orgName: '',
        roles: [],
      };
      const { receiptId } = await saga.requestSourceDeletion(
        principal,
        'task_conclusion',
        row.source_id,
      );
      // Run the external leg inline rather than leaving it queued: this script
      // is the whole operation, and a pending receipt would block the sweep.
      const result = await db.transaction((tx) => executor.execute(tx, receiptId));
      confirmed += 1;
      console.log(
        `  ${row.source_id} → receipt ${receiptId} confirmed ` +
          `(${result.points} point(s), ${result.objects} object(s))`,
      );
    }
    console.log(`done: ${confirmed} receipt(s) confirmed. Migration 0035 can now run.`);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  // `process.exit` immediately after a write can truncate it when stdout is a
  // pipe (docker exec, CI): set the code and let the process end on its own.
  console.error(
    `erase-task-conclusions FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});

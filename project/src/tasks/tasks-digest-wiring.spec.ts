import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../infrastructure/index';
import { MemoryStore } from '../memory/index';
import { DIGEST_TASK_SECTION } from '../ingestion/index';
import { TasksModule } from './tasks.module';
import { TasksDigestSection } from './tasks-digest';

/**
 * DI smoke for the digest port (O2-A; decision 0018 ruling 3) — infra-free.
 * Reproduces the production wiring SHAPE: DRIZZLE and MemoryStore arrive from a
 * GLOBAL module (in production, DatabaseModule and MemoryModule), and
 * `TasksModule.forDigest()` provides `DIGEST_TASK_SECTION` globally. Proves the
 * token resolves to a real `TasksDigestSection` whose cross-module global deps
 * wire up — the part the composition tests (which `new` the section directly)
 * do not exercise.
 */
@Global()
@Module({
  providers: [
    { provide: DRIZZLE, useValue: {} },
    { provide: MemoryStore, useValue: {} },
  ],
  exports: [DRIZZLE, MemoryStore],
})
class FakeGlobals {}

@Module({ imports: [FakeGlobals, TasksModule.forDigest()] })
class Root {}

describe('digest port wiring', () => {
  let ctx: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | null = null;
  afterEach(async () => {
    await ctx?.close();
    ctx = null;
  });

  it('forDigest registers DIGEST_TASK_SECTION as a resolvable global provider', async () => {
    ctx = await NestFactory.createApplicationContext(Root, { logger: false });
    expect(ctx.get(DIGEST_TASK_SECTION)).toBeInstanceOf(TasksDigestSection);
  });
});

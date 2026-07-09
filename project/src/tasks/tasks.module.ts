import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DIGEST_TASK_SECTION } from '../ingestion/index';
import { TasksCascade } from './tasks-cascade';
import { TasksController } from './tasks.controller';
import { TasksDigestSection } from './tasks-digest';
import { TasksEngine } from './tasks.engine';

/**
 * tasks — memory turned into action (scope §4.7; decision 0013): the
 * task-derivation engine, the audited user operations, and the debug-grade
 * task surface. Reads memory through its public interface; NEVER mutates it.
 * Reminders, the digest section, and the real UI are O2
 * (docs/handoff/F3-tasks.md).
 */
@Module({})
export class TasksModule {
  /** Worker slice: the engine (derivation, judgments, backfill, cascade). */
  static register(): DynamicModule {
    return {
      module: TasksModule,
      providers: [TasksEngine, TasksCascade],
      exports: [TasksEngine, TasksCascade],
    };
  }

  /** App slice: the engine (user ops + reads) behind the task endpoints. */
  static forApi(): DynamicModule {
    return {
      module: TasksModule,
      controllers: [TasksController],
      providers: [TasksEngine, TasksCascade],
      exports: [TasksEngine, TasksCascade],
    };
  }

  /**
   * The digest's TASKS section as a GLOBAL provider (O2-A): ingestion's
   * DreamingController — a different module — injects it OPTIONALLY under
   * `DIGEST_TASK_SECTION`, so the tasks section joins the digest without
   * ingestion ever importing tasks (the dependency stays tasks → ingestion).
   * Follows the codebase's global-seam pattern (MemoryStore, the DB handle).
   */
  static forDigest(): DynamicModule {
    return {
      module: TasksModule,
      global: true,
      providers: [
        TasksDigestSection,
        { provide: DIGEST_TASK_SECTION, useExisting: TasksDigestSection },
      ],
      exports: [DIGEST_TASK_SECTION],
    };
  }
}

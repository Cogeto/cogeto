import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { TasksCascade } from './tasks-cascade';
import { TasksController } from './tasks.controller';
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
}

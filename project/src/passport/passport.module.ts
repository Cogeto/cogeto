import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { TasksModule } from '../tasks/index';
import { PassportController } from './passport.controller';
import { PassportService } from './passport.service';
import { PassportExportStore } from './passport.store';
import { PassportExportExecutor } from './passport-export.executor';
import { PASSPORT_OPTIONS } from './passport.options';
import type { PassportOptions } from './passport.options';

/**
 * passport — the Memory Passport (§B.5, decision 0029): a complete, documented,
 * versioned export of a user's own data. It composes the memory module's gated
 * reads + object store and the tasks engine (like retrieval composes them),
 * owns only its request/status ledger, and signs the manifest with the instance
 * key in the worker. Every read is Principal-gated: a user exports only what
 * they may see.
 */
@Module({})
export class PassportModule {
  static register(options: PassportOptions): DynamicModule {
    return {
      module: PassportModule,
      imports: [TasksModule.register()],
      controllers: [PassportController],
      providers: [
        { provide: PASSPORT_OPTIONS, useValue: options },
        PassportService,
        PassportExportStore,
        PassportExportExecutor,
      ],
      exports: [PassportExportExecutor, PassportExportStore],
    };
  }
}

import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextService,
} from '../infrastructure/index';
import { SkillRunService } from './skills/skill-run.service';
import { SKILL_ENGINE_OPTIONS, SkillEngine } from './skills/skill-engine';
import type { SkillEngineOptions } from './skills/skill-engine';

export interface ConnectorsModuleOptions {
  /** The research family's dynamic module instance — the skill engine drives
   * discovery and capture through ResearchService (the approval gate). */
  imports?: ModuleMetadata['imports'];
}

/**
 * connectors — what remains after the part-4 family split: the named-skills
 * runtime (the run record + engine live in BOTH roots; the planner and its
 * surface are the app-only SkillsModule). The final split step dissolves this
 * module into `skills/` and deletes the directory.
 */
@Module({})
export class ConnectorsModule {
  static register(options: ConnectorsModuleOptions = {}): DynamicModule {
    return {
      module: ConnectorsModule,
      // RECORDED EXCEPTION B14 (docs/module-boundary-contract.md): still a
      // global domain module until the skills split lands; the remaining
      // globality is exactly the skill runtime.
      global: true,
      imports: [...(options.imports ?? [])],
      providers: [
        SkillRunService,
        SkillEngine,
        {
          provide: SKILL_ENGINE_OPTIONS,
          useFactory: (
            userContext?: UserContextService,
            timeZone?: string,
          ): SkillEngineOptions => ({
            userContext,
            instanceTimeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
          }),
          inject: [
            { token: UserContextService, optional: true },
            { token: INSTANCE_TIMEZONE, optional: true },
          ],
        },
      ],
      exports: [SkillRunService, SkillEngine],
    };
  }
}

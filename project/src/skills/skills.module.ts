import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextService,
} from '../infrastructure/index';
import { SkillRunService } from './skill-run.service';
import { SKILL_ENGINE_OPTIONS, SkillEngine } from './skill-engine';
import type { SkillEngineOptions } from './skill-engine';

/**
 * skills — the named-skill runtime (V2.0 item 3.6 part 4, the last family
 * out of the dissolved connectors context): the run record and the engine,
 * composed into BOTH roots (the app approves plans, the worker advances).
 * The planner and its surface are the app-only SkillsChatModule. NOT global:
 * the roots pass the research family instance through `imports`, and every
 * consumer resolves the engine explicitly.
 */
@Module({})
export class SkillsModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: SkillsModule,
      imports: [...(options.imports ?? [])],
      providers: [
        SkillRunService,
        SkillEngine,
        // The engine's optional collaborators, by TOKEN into a named bag:
        // identity, never position.
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

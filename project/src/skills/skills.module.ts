import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextService,
} from '../infrastructure/index';
import { MemorySystemStore } from '../memory/index';
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
            systemMemories?: MemorySystemStore,
          ): SkillEngineOptions => ({
            userContext,
            instanceTimeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
            systemMemories,
          }),
          inject: [
            { token: UserContextService, optional: true },
            { token: INSTANCE_TIMEZONE, optional: true },
            // Worker-only by construction (V2.0 item 3.7): the memory module
            // instance the worker root passes in exports MemorySystemStore, the
            // app root's does not provide it at all. Optional here because the
            // engine is registered in BOTH roots (the app approves a plan, the
            // worker advances it) — and deliberately unresolvable rather than
            // merely unused in the app, so no request path can obtain it.
            { token: MemorySystemStore, optional: true },
          ],
        },
      ],
      exports: [SkillRunService, SkillEngine],
    };
  }
}

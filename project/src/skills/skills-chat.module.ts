import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { CHAT_SKILL_RESOLVER, RetrievalModule } from '../retrieval/index';
import { ChatSkillResolver } from './chat-skill-resolver';
import { SkillPlanner } from './skill-planner';
import { SkillsController } from './skills.controller';

/**
 * The skill flow's app-only composition — the ResearchChatModule shape:
 * planning needs RetrievalService (the entity profile), so this is composed
 * ONLY into the app root, never the worker (whose skill intent stays inert;
 * execution reaches the worker as the `skill.advance` job through the skills
 * family's SkillEngine). `imports` receives the research and skills family
 * instances the planner and surface inject.
 *
 * RECORDED EXCEPTION B15 (docs/module-boundary-contract.md): still global, so
 * ChatService (in RetrievalModule, which this module imports) resolves
 * CHAT_SKILL_RESOLVER. Un-globaling it today would silently drop skills from
 * chat; the chat split later in part 4 removes the reason.
 */
@Module({})
export class SkillsChatModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: SkillsChatModule,
      global: true,
      imports: [RetrievalModule, ...(options.imports ?? [])],
      controllers: [SkillsController],
      providers: [
        SkillPlanner,
        ChatSkillResolver,
        { provide: CHAT_SKILL_RESOLVER, useExisting: ChatSkillResolver },
      ],
      exports: [CHAT_SKILL_RESOLVER],
    };
  }
}

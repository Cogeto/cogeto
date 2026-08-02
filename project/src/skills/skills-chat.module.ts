import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { RetrievalModule } from '../retrieval/index';
import { CHAT_SKILL_RESOLVER } from '../chat/index';
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
 * NOT global since B15 closed (V2.0 item 3.6 part 4): the app root passes
 * this instance into ChatModule.register, whose options factory resolves
 * CHAT_SKILL_RESOLVER by token, and the boot assertion proves the seam took.
 */
@Module({})
export class SkillsChatModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: SkillsChatModule,
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

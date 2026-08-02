import { Global, Module } from '@nestjs/common';
import { CHAT_SKILL_RESOLVER, RetrievalModule } from '../../retrieval/index';
import { ChatSkillResolver } from './chat-skill-resolver';
import { SkillPlanner } from './skill-planner';
import { SkillsController } from './skills.controller';

/**
 * The skill flow's app-only composition — the
 * ResearchChatModule shape: planning needs RetrievalService (the entity
 * profile), so this is composed ONLY into the app root, never the worker
 * (whose skill intent stays inert; execution reaches the worker as the
 * `skill.advance` job through ConnectorsModule's SkillEngine).
 *
 * RECORDED EXCEPTION B15 (docs/module-boundary-contract.md): still global, so
 * ChatService (in RetrievalModule, which this module imports) resolves
 * CHAT_SKILL_RESOLVER. Un-globaling it today would silently null an
 * @Optional() argument and drop skills from chat with every test still green.
 * V2.0 item 3.6 part 4 removes the reason.
 */
@Global()
@Module({
  imports: [RetrievalModule],
  controllers: [SkillsController],
  providers: [
    SkillPlanner,
    ChatSkillResolver,
    { provide: CHAT_SKILL_RESOLVER, useExisting: ChatSkillResolver },
  ],
  exports: [CHAT_SKILL_RESOLVER],
})
export class SkillsModule {}

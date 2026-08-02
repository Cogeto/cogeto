/** Public interface of the connectors bounded context (spec §15 rule 1). */
export { ConnectorsModule } from './connectors.module';
export type { ConnectorsModuleOptions } from './connectors.module';
// Web research.
export { ResearchService } from './research.service';
// Server-side research conclusion: the settle-watcher the
// worker calls after each web page's pipeline job, and the conclusion job type.
export { ResearchConclusionService, RESEARCH_CONCLUDE_JOB_TYPE } from './research-conclude';
// Part B: minimisation, the gate, chat seam, synthesis —
// ResearchChatModule is composed ONLY into the app root (needs retrieval).
export { minimiseQuery, RESEARCH_MINIMISE_PROMPT } from './research-minimise';
export type { MinimisedQuery } from './research-minimise';
export { ChatResearchResolver } from './chat-research-resolver';
export {
  RESEARCH_SYNTHESIS_OPTIONS,
  ResearchSynthesisService,
  RESEARCH_ANSWER_PROMPT,
} from './research-synthesis.service';
export type { ResearchSynthesisOptions } from './research-synthesis.service';
export { ResearchChatModule } from './research-chat.module';
export { WebDiscoveryService } from './web-discovery.service';
export type { DiscoveryOutcome, DiscoveredPage } from './web-discovery.service';
export { WebFetchService, isPrivateAddress, robotsAllows } from './web-fetch';
export type { FetchOutcome, FetchedPage } from './web-fetch';
export { WebSourceReader } from './web.source-reader';
export { WebSourceDeletion } from './web.source-deletion';
export { RESEARCH_OPTIONS } from './research-options';
export type { ResearchOptions } from './research-options';
// Named skills: the runtime (both roots), the
// app-only SkillsModule (planner + controller + chat seam), the registry.
export { SkillRunService, SKILL_ADVANCE_JOB_TYPE } from './skills/skill-run.service';
export { SkillEngine, SKILL_BRIEF_PROMPT, resolveBriefMarkers } from './skills/skill-engine';
export { SkillPlanner, SKILL_PLAN_PROMPT, ambiguousCandidates } from './skills/skill-planner';
export { SkillsModule } from './skills/skills.module';
export { ChatSkillResolver } from './skills/chat-skill-resolver';
export { getSkill, listSkills, RESEARCH_BRIEF_SKILL } from './skills/skill-registry';
export type { SkillDefinition, SkillStepDef } from './skills/skill-registry';
export { selectPagesForSubject } from './skills/page-select';

/** Public interface of the connectors bounded context (spec §15 rule 1). */
export { ConnectorsModule } from './connectors.module';
// Named skills.
export { SkillRunService, SKILL_ADVANCE_JOB_TYPE } from './skills/skill-run.service';
export {
  SkillEngine,
  SKILL_ENGINE_OPTIONS,
  SKILL_BRIEF_PROMPT,
  resolveBriefMarkers,
} from './skills/skill-engine';
export type { SkillEngineOptions } from './skills/skill-engine';
export { SkillPlanner, SKILL_PLAN_PROMPT, ambiguousCandidates } from './skills/skill-planner';
export { SkillsModule } from './skills/skills.module';
export { ChatSkillResolver } from './skills/chat-skill-resolver';
export { getSkill, listSkills, RESEARCH_BRIEF_SKILL } from './skills/skill-registry';
export type { SkillDefinition, SkillStepDef } from './skills/skill-registry';
export { selectPagesForSubject } from './skills/page-select';

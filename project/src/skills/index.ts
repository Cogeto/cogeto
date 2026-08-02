/**
 * skills — named skills over the research gate (V2.0 item 3.6 part 4, the
 * last family out of the dissolved connectors context). A skill plans, the
 * user approves the plan, the worker advances the run; the brief cites what
 * it used and creates nothing else.
 */
export { SkillsModule } from './skills.module';
export { SkillsChatModule } from './skills-chat.module';
export { SkillRunService, SKILL_ADVANCE_JOB_TYPE } from './skill-run.service';
export {
  SkillEngine,
  SKILL_ENGINE_OPTIONS,
  SKILL_BRIEF_PROMPT,
  resolveBriefMarkers,
} from './skill-engine';
export type { SkillEngineOptions } from './skill-engine';
export { SkillPlanner, SKILL_PLAN_PROMPT, ambiguousCandidates } from './skill-planner';
export { ChatSkillResolver } from './chat-skill-resolver';
export { getSkill, listSkills, RESEARCH_BRIEF_SKILL } from './skill-registry';
export type { SkillDefinition, SkillStepDef } from './skill-registry';
export { selectPagesForSubject } from './page-select';

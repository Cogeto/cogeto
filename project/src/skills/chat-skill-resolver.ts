import { Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import type { ChatSkillProposal, ChatSkillResolverPort } from '../chat/index';
import { RESEARCH_BRIEF_SKILL } from './skill-registry';
import { SkillPlanner } from './skill-planner';
import { SkillRunService } from './skill-run.service';

/**
 * The chat → skill seam's connectors side: chat's brief intent
 * starts planning through this — propose only, never approve. Bound to
 * CHAT_SKILL_RESOLVER by the app root (SkillsModule); the worker never binds it.
 */
@Injectable()
export class ChatSkillResolver implements ChatSkillResolverPort {
  constructor(
    private readonly planner: SkillPlanner,
    private readonly runs: SkillRunService,
  ) {}

  async propose(principal: Principal, subject: string): Promise<ChatSkillProposal> {
    const outcome = await this.planner.propose(principal, RESEARCH_BRIEF_SKILL.id, subject);
    if (outcome.status === 'ambiguous') {
      return { status: 'ambiguous', candidates: outcome.candidates };
    }
    const plan = await this.runs.steps(outcome.run.id);
    const planStep = plan.find((s) => s.stepKey === 'plan_searches');
    const queryCount =
      ((planStep?.links as { counts?: { queries?: number } })?.counts?.queries ?? 0) || 0;
    return { status: 'created', runId: outcome.run.id, queryCount };
  }
}

import { Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import type { ChatResearchProposal, ChatResearchResolverPort } from '../retrieval/index';
import { ResearchService } from './research.service';

/**
 * The chat → research seam's connectors side (Priority 5 Part B): chat's
 * research intent opens the gate through this — propose only, never approve.
 * Bound to CHAT_RESEARCH_RESOLVER by the app root (ResearchChatModule); the
 * worker never binds it.
 */
@Injectable()
export class ChatResearchResolver implements ChatResearchResolverPort {
  constructor(private readonly research: ResearchService) {}

  async propose(principal: Principal, intent: string): Promise<ChatResearchProposal> {
    const run = await this.research.propose(principal, intent);
    return {
      runId: run.id,
      intent: run.intent,
      minimisedQuery: run.minimisedQuery,
      minimiseReason: run.minimiseReason,
    };
  }
}

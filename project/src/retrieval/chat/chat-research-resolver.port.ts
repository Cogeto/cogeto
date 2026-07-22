import type { Principal } from '@cogeto/shared';

/**
 * The chat → research seam (Priority 5 Part B, decision 0045) — the same
 * cross-module pattern as CHAT_REPLY_RESOLVER: retrieval defines the port,
 * connectors implements it (ResearchService), the APP composition root binds
 * it. ChatService never imports connectors; the worker never binds it, so the
 * research intent is inert there.
 *
 * The port deliberately exposes ONLY `propose`: chat can open the gate
 * (minimise + record a proposed run — nothing leaves), never approve it.
 * Approval is an explicit user action on the Research page.
 */
export interface ChatResearchProposal {
  runId: string;
  intent: string;
  minimisedQuery: string;
  minimiseReason: string;
}

export interface ChatResearchResolverPort {
  propose(principal: Principal, intent: string): Promise<ChatResearchProposal>;
}

export const CHAT_RESEARCH_RESOLVER = Symbol('CHAT_RESEARCH_RESOLVER');

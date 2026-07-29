import type { Principal } from '@cogeto/shared';

/**
 * The chat → skill seam — the CHAT_RESEARCH_RESOLVER
 * pattern: retrieval defines the port, connectors implements it, the APP
 * composition root binds it. ChatService never imports connectors; the worker
 * never binds it, so the skill intent is inert there.
 *
 * The port exposes ONLY `propose`: chat can start planning (gather + plan —
 * nothing leaves), never approve the plan. Approval is an explicit user action
 * on the run view's gate.
 */
export type ChatSkillProposal =
  | { status: 'created'; runId: string; queryCount: number }
  | { status: 'ambiguous'; candidates: string[] };

export interface ChatSkillResolverPort {
  propose(principal: Principal, subject: string): Promise<ChatSkillProposal>;
}

export const CHAT_SKILL_RESOLVER = Symbol('CHAT_SKILL_RESOLVER');

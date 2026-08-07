/**
 * retrieval — hybrid, fused, filtered search (spec §3.4).
 * One read API: retrieve(principal, query, opts) on RetrievalService. The chat
 * area moved to its own `chat/` context in V2.0 item 3.6 part 4; the rewriter
 * and intent detectors stay here because retrieval owns the query language.
 */
export { RetrievalModule } from './retrieval.module';
export { RETRIEVAL_SERVICE_OPTIONS, RetrievalService } from './retrieval.service';
export type {
  OpenLoop,
  RetrievalMode,
  RetrievedMemory,
  RetrieveOptions,
} from './retrieval.service';
export type { ConversationTurn } from './query-rewrite';
export {
  ANAPHORA_RE,
  detectEmailReplyIntent,
  detectResearchIntent,
  detectSkillBriefIntent,
  detectSmallTalk,
  OPEN_LOOPS_HINT_RE,
  resolveQuestionClass,
  rewriteQuery,
  QUERY_REWRITE_PROMPT,
  TEMPORAL_HINT_RE,
} from './query-rewrite';
export type { SmallTalkIntent, RewriteResult, TemporalIntent } from './query-rewrite';
export { queryEntityCandidates } from './query-entities';
export { detectEntityProfile } from './entity-profile';
// The ambiguity decision (V2.3 item 6.3, spec §7.5): the pure rule and its
// versioned thresholds — chat renders the behaviours, this module decides.
export { clusterBySubject, decideAmbiguity } from './ambiguity';
export type { AmbiguityCluster, AmbiguityHit, EntityKeyOf } from './ambiguity';
export {
  AMBIGUITY_CONFIG_VERSION,
  ambiguityThresholdsFor,
  MAX_FANOUT_LINES,
} from './ambiguity-config';
export type { AmbiguityThresholds } from './ambiguity-config';
export { runRewriteEval } from './eval-rewrite';
export type { RewriteEvalMetrics } from './eval-rewrite';

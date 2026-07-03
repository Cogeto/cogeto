/**
 * Public interface of the retrieval bounded context (§A.1 rule 1).
 * One read API: retrieve(principal, query, opts) on RetrievalService.
 */
export { RetrievalModule } from './retrieval.module';
export { RetrievalService } from './retrieval.service';
export type { RetrieveOptions, RetrievedMemory } from './retrieval.service';
export type { RetrievalSignal } from './fusion';
// The chat area's prompt family ref — the worker registers it on boot (§B.7).
export { ANSWER_PROMPT } from './chat/answer-prompt';

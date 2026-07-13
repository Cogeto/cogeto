/**
 * Ana sandbox demo tooling (decision 0022) — composition-root code shared by the
 * demo-seed / demo-reset entrypoints and the worker's scheduled reset. Excluded
 * from production images (see the Dockerfile). Not a domain module: it drives
 * the system through the public HTTP API and, as an ops tool, touches tables
 * directly for draining/ageing/wiping only.
 */
export { loadCorpus, loadDocumentBytes, demoRoot } from './corpus';
export type { Corpus, CorpusNote, CorpusDocument } from './corpus';
export { createDemoApi } from './http-client';
export type { DemoApi } from './http-client';
export { establishDemoSession, waitForApp } from './bootstrap';
export type { DemoSession } from './bootstrap';
export { seedDemoWorld, captureCorpus, alreadySeeded } from './seed';
export type { SeedWorldDeps } from './seed';
export { resetDemoWorld, DemoResetInProgressError } from './reset';
export type { ResetDeps } from './reset';
export { inspectEndState, assertEndState, summarize } from './assertions';
export type { DemoEndState } from './assertions';
export { provisionDemoPrincipal } from './zitadel-admin';

/** Graphile task identifier for the scheduled reset (demo profile only). */
export const DEMO_RESET_JOB_TYPE = 'demo_reset';

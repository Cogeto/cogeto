import type { Db } from '../infrastructure/index';
import type { MemoryStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { chunkContent } from './pipeline/chunk';
import { ExtractStage } from './pipeline/extract.stage';
import { VerifyStage } from './pipeline/verify.stage';
import { EmbedStoreStage } from './pipeline/embed-store.stage';
import type { AdmittedMemory } from './pipeline/embed-store.stage';
import type { SourceItem } from './pipeline/source-reader';

/**
 * Seed one source through the REAL pipeline (chunk → extract → verify → embed +
 * store) into Postgres + Qdrant, in one transaction — the composition the chat
 * eval harness uses to build a fresh test instance from a case's notes. Same
 * stages the worker runs; no queue, so seeding is synchronous. Exposed as part
 * of ingestion's eval API alongside runGoldenEval.
 */
export async function seedMemoryFromSource(opts: {
  db: Db;
  gateway: ModelGateway;
  memoryStore: MemoryStore;
  source: SourceItem;
}): Promise<AdmittedMemory[]> {
  const extract = new ExtractStage(opts.gateway);
  const verify = new VerifyStage(opts.gateway);
  const embedStore = new EmbedStoreStage(opts.gateway, opts.memoryStore);

  const chunks = chunkContent(opts.source.content);
  const facts = await extract.run(opts.source, chunks);
  const verified = await verify.run(chunks, facts);
  return opts.db.transaction((tx) => embedStore.run(tx, opts.source, verified));
}

/** Test-only harness — never imported by production code (dependency-cruiser rule). */
export { startTestDatabase, settleJobs } from './pg';
export type { TestDatabase } from './pg';
export { startTestQdrant, fakeEmbedding } from './qdrant';
export type { TestQdrant } from './qdrant';
export { startTestMinio } from './minio';
export type { TestMinio } from './minio';
export { makePdf, makeDocx } from './documents';

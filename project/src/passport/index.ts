/**
 * Public interface of the passport bounded context (spec §15 rule 1) — the Memory
 * Passport (spec §11.4). The composition roots register the module and
 * the worker wires the export + retention jobs; assembly internals stay private.
 */
export { PassportModule } from './passport.module';
// The deletion-saga arm (SEC-8): passport exports must not outlive a deletion.
export { PassportCascadeModule } from './passport-cascade.module';
export { PassportExportCascade } from './passport.source-expiry';
export { PassportExportExecutor } from './passport-export.executor';
export {
  PASSPORT_EXPORT_JOB_TYPE,
  PASSPORT_RETENTION_JOB_TYPE,
  PASSPORT_RETENTION_CRONTAB,
} from './passport.store';
export { PASSPORT_OPTIONS, PASSPORT_EXPORT_RETENTION_HOURS } from './passport.options';
// The space display-name port (docs/features/spaces.md): the composition root
// binds the spaces module's implementation so the per-space manifest can name
// the space it exports.
export { SPACE_NAME_RESOLVER } from './space-name.port';
export type { SpaceNameResolver } from './space-name.port';
// Format + assembler exposed for the eval/verify harness and the schema tests.
export { manifestSchema, sha256Hex } from './passport-format';
// Space deletion's passport leg (docs/features/spaces.md section 5).
export { PassportSpaceCleanup, PassportSpaceCleanupModule } from './passport-space-cleanup';

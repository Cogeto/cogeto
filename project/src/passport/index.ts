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
  PassportExportStore,
  PASSPORT_EXPORT_JOB_TYPE,
  PASSPORT_RETENTION_JOB_TYPE,
  PASSPORT_RETENTION_CRONTAB,
} from './passport.store';
export { PASSPORT_OPTIONS, PASSPORT_EXPORT_RETENTION_HOURS } from './passport.options';
export type { PassportOptions } from './passport.options';
// Format + assembler exposed for the eval/verify harness and the schema tests.
export { assemblePassport } from './passport-assembler';
export type { PassportInput, AssembledPassport, PassportSubject } from './passport-assembler';
export {
  manifestSchema,
  memoriesDocSchema,
  receiptsDocSchema,
  sha256Hex,
  PASSPORT_PATHS,
} from './passport-format';
export type { Manifest, MemoryExport, ReceiptExport } from './passport-format';
export { createZip, readZip } from './zip';
export type { ZipEntry } from './zip';

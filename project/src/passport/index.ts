/**
 * Public interface of the passport bounded context (§A.1 rule 1) — the Memory
 * Passport (§B.5, decision 0029). The composition roots register the module and
 * the worker wires the export + retention jobs; assembly internals stay private.
 */
export { PassportModule } from './passport.module';
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
  tasksDocSchema,
  receiptsDocSchema,
  sha256Hex,
  PASSPORT_PATHS,
} from './passport-format';
export type { Manifest, MemoryExport, TaskExport, ReceiptExport } from './passport-format';
export { createZip, readZip } from './zip';
export type { ZipEntry } from './zip';

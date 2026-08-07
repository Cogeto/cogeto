/**
 * The report generation job — a one-shot worker task per run, idempotent by
 * the (source_type, source_id, job_type) key with the run id as source_id.
 */
export const REPORT_GENERATE_JOB_TYPE = 'report.generate';

/**
 * The recurring retention pass that expires rendered report artifacts.
 * Underscore identifier: graphile's crontab parser rejects dots (a dotted
 * name crashes the worker on boot).
 */
export const REPORT_RETENTION_JOB_TYPE = 'report_retention';

/** Hourly retention sweep at :45 (offset from passport's :30 so the two
 * artifact sweeps never contend for the same worker slot). */
export const REPORT_RETENTION_CRONTAB = `45 * * * * ${REPORT_RETENTION_JOB_TYPE}`;

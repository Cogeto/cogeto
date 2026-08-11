/**
 * Job-type contracts owned by `confluence` (V2.5 item 8.2; boundary
 * contract section 3).
 */

/**
 * The honest backfill estimate (issue B2): counting pages needs the
 * credential, and the credential opens only in the worker, so the estimate
 * is a job. It counts the CQL each selected scope's sync would run, for the
 * connector's current backfill settings, and writes the result to the
 * sub-scope stats the settings surface polls.
 */
export const CONFLUENCE_ESTIMATE_JOB_TYPE = 'confluence.estimate';

/**
 * The import coordinator's job type (V2.2 item 5.3). A PLAIN, re-runnable
 * task (the research-conclude shape), because one run advances many times;
 * a per-run single-flight lock keeps passes from overlapping.
 */
export const IMPORT_ADVANCE_JOB_TYPE = 'import.advance';

/**
 * The queue priority import pipeline jobs run at: numerically LARGER than the
 * interactive default (0), so any single upload, chat attachment, capture or
 * reprocess enqueued while an import runs jumps ahead of the import's queued
 * documents. Combined with the in-flight cap below, an import can occupy at
 * most one worker slot's worth of queued work at a time.
 */
export const IMPORT_PIPELINE_PRIORITY = 100;

/**
 * How many of an import's documents may be queued or processing at once.
 * Default 1: the worker runs concurrency 2, so one slot always remains free
 * for interactive work even mid-document; the env knob raises it on beefier
 * deployments (stated in the PR body, tunable via COGETO_IMPORT_IN_FLIGHT).
 */
export const IMPORT_IN_FLIGHT_DEFAULT = 1;

/** The DI token the worker root binds the in-flight cap to. */
export const IMPORT_IN_FLIGHT = Symbol('IMPORT_IN_FLIGHT');

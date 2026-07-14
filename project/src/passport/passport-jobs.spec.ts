import { parseCrontab } from 'graphile-worker';
import { describe, expect, it } from 'vitest';
import {
  PASSPORT_EXPORT_JOB_TYPE,
  PASSPORT_RETENTION_CRONTAB,
  PASSPORT_RETENTION_JOB_TYPE,
} from './passport.store';

/**
 * Guards the boot crash this spec was written for: graphile-worker's crontab
 * parser rejects a task identifier containing a dot ("Invalid command
 * specification"), so a dotted job type in the crontab crash-loops the worker.
 * Job identifiers must be underscore-only (the repo convention: deletion_sweep,
 * approval_expiry, …), and the retention crontab must actually parse.
 */
describe('passport job identifiers', () => {
  it.each([PASSPORT_EXPORT_JOB_TYPE, PASSPORT_RETENTION_JOB_TYPE])(
    'job type %s is a graphile-safe identifier (no dots)',
    (jobType) => {
      expect(jobType).toMatch(/^[a-z0-9_]+$/);
    },
  );

  it('the retention crontab parses under graphile-worker', () => {
    expect(() => parseCrontab(PASSPORT_RETENTION_CRONTAB)).not.toThrow();
  });
});

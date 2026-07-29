import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * no_second_scheduler (F2 handoff §4): every recurring job reuses the ONE
 * graphile cron — crontab lines, never a second scheduler. A static guard
 * exactly one file configures the graphile runner's `crontab`, that file is the
 * worker entrypoint, and no module pulls in a competing scheduler library.
 *
 * Moved here from the tasks module when that module was removed : the invariant was never about reminders, it was about there being one
 * scheduler, and it outlives the job that first motivated it.
 */
const SRC_ROOT = path.resolve(__dirname, '..');

function productionSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) acc.push(full);
  }
  return acc;
}

describe('no_second_scheduler', () => {
  const files = productionSources(SRC_ROOT);

  it('only the worker entrypoint configures a graphile crontab', () => {
    // The graphile runner option is `crontab: \`…\`` — distinct from the
    // *_CRONTAB constant definitions and from prose mentioning "the crontab".
    const configuring = files.filter((f) => /crontab:\s*[`'"]/.test(readFileSync(f, 'utf8')));
    expect(configuring.map((f) => path.basename(f))).toEqual(['worker.ts']);
  });

  it('every recurring job joins that ONE crontab as a line', () => {
    const worker = readFileSync(path.join(SRC_ROOT, 'entrypoints', 'worker.ts'), 'utf8');
    // Each surviving nightly/periodic pass is a *_CRONTAB constant interpolated
    // into the single crontab string — a new one must be added the same way.
    for (const line of [
      'SWEEP_CRONTAB',
      'DREAM_CRONTAB',
      'APPROVAL_EXPIRY_CRONTAB',
      'PASSPORT_RETENTION_CRONTAB',
      'EMAIL_REFUSAL_RETENTION_CRONTAB',
    ]) {
      expect(worker, `${line} must be scheduled on the one crontab`).toMatch(
        new RegExp(`\\$\\{${line}\\}`),
      );
    }
  });

  it('no module imports a competing scheduler library', () => {
    const banned =
      /from\s+['"](node-cron|node-schedule|cron|bull|bullmq|agenda|toad-scheduler)['"]/;
    const offenders = files.filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * no_second_scheduler (O2-A; F3 handoff §2 + F2 handoff §4): the reminders pass
 * must reuse the EXISTING graphile cron — one crontab line, one task — never a
 * new scheduler. A static guard: exactly one file configures the graphile
 * runner's `crontab`, that file is the worker entrypoint, and it schedules the
 * reminders line; no module pulls in a competing scheduler library.
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

  it('only the worker entrypoint configures a graphile crontab, and it schedules reminders', () => {
    // The graphile runner option is `crontab: \`…\`` — distinct from the
    // *_CRONTAB constant definitions and from prose mentioning "the crontab".
    const configuring = files.filter((f) => /crontab:\s*[`'"]/.test(readFileSync(f, 'utf8')));
    expect(configuring.map((f) => path.basename(f))).toEqual(['worker.ts']);

    const worker = readFileSync(configuring[0]!, 'utf8');
    // Reminders join the ONE scheduler as a crontab line — not a new runner.
    expect(worker).toMatch(/TASKS_REMINDERS_CRONTAB/);
  });

  it('no module imports a competing scheduler library', () => {
    const banned =
      /from\s+['"](node-cron|node-schedule|cron|bull|bullmq|agenda|toad-scheduler)['"]/;
    const offenders = files.filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

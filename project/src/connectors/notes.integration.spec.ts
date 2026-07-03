import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { NotesService } from './notes.service';

const principal: Principal = {
  userId: 'user-notes',
  name: 'Notes User',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

describe('notes capture (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let service: NotesService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    service = new NotesService(tdb.db);
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };
  const countJobs = () =>
    count(`SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE task_identifier = $1`, [
      INGESTION_PIPELINE_JOB_TYPE,
    ]);

  it('capture_transactional: a failed note insert leaves no job; success leaves note + job exactly once', async () => {
    // Failure: NOT NULL violation on content — the capture transaction rolls
    // back as one unit: no note, no outbox event, no pipeline job.
    const jobsBefore = await countJobs();
    await expect(service.createNote(principal, null as unknown as string)).rejects.toThrow();
    expect(await count('SELECT count(*)::text AS n FROM note')).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM outbox_event`)).toBe(0);
    expect(await countJobs()).toBe(jobsBefore);

    // Success: exactly one note, one note.captured event, one pipeline job
    // keyed (user_note, <note id>).
    const created = await service.createNote(principal, 'Send the revised proposal to Luka.');
    expect(await count('SELECT count(*)::text AS n FROM note WHERE id = $1', [created.id])).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM outbox_event
         WHERE event_type = 'note.captured' AND payload->>'source_id' = $1`,
        [created.id],
      ),
    ).toBe(1);
    // The public jobs view exposes no payload; the private table does.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM graphile_worker._private_jobs
         WHERE payload->>'source_id' = $1`,
        [created.id],
      ),
    ).toBe(1);

    // Owner gate on the source drawer read.
    expect(await service.getNoteForOwner(principal, created.id)).not.toBeNull();
    expect(
      await service.getNoteForOwner({ ...principal, userId: 'someone-else' }, created.id),
    ).toBeNull();

    // Nothing has processed the job yet: the poll endpoint reports processing.
    expect(await service.getProcessingState(created.id)).toBe('processing');
  });
});

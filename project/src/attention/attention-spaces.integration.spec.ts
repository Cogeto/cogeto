import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { AttentionService } from './attention.service';
import { attentionDismissal, attentionState } from './persistence/tables';

/**
 * The attention read state is per (user, space) (docs/features/spaces.md
 * section 6c, issue D3): opening the dashboard in one space must not silence
 * another space's unread indicator, and a dismissal in one space can never
 * suppress a line in another, because the space is a real column on both
 * rows, not just a segment inside the key string. Real Postgres; only the
 * read-state methods run, so the feed collaborators are not constructed.
 */

const OWNER = 'user-attention-spaces';
const SPACE_B = 'bbbbbbbb-0000-4000-8000-0000000000a1';

function principalIn(spaceId?: string): Principal {
  return {
    userId: OWNER,
    name: '',
    email: null,
    orgId: 'org-a',
    orgName: '',
    roles: [],
    ...(spaceId ? { spaceId } : {}),
  };
}

describe('attention read state per space (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let service: AttentionService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    await tdb.pool.query(`INSERT INTO space (id, name) VALUES ($1, $2)`, [SPACE_B, 'Space B']);
    // Only markSeen/dismiss run here; the feed collaborators stay absent.
    service = new AttentionService(
      tdb.db,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('marking_seen_in_one_space_never_silences_another: one last-seen row per (user, space)', async () => {
    await service.markSeen(principalIn());
    await service.markSeen(principalIn(SPACE_B));
    const rows = await tdb.db
      .select()
      .from(attentionState)
      .where(eq(attentionState.ownerId, OWNER));
    expect(rows.map((r) => r.spaceId).sort()).toEqual([DEFAULT_SPACE_ID, SPACE_B].sort());
    // Re-marking updates only the caller's space's row.
    const before = rows.find((r) => r.spaceId === SPACE_B)!.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.markSeen(principalIn());
    const after = await tdb.db
      .select()
      .from(attentionState)
      .where(and(eq(attentionState.ownerId, OWNER), eq(attentionState.spaceId, SPACE_B)));
    expect(after[0]!.lastSeenAt.getTime()).toBe(before.getTime());
  });

  it('a_dismissal_carries_the_caller_space_column: a forged key cannot reach another space', async () => {
    // A key naming ANOTHER space's segment is stored under the caller's own
    // space column, so it can never match an item rendered in that space.
    await service.dismiss(principalIn(), `digest:run-1:${SPACE_B}:0`);
    const rows = await tdb.db
      .select()
      .from(attentionDismissal)
      .where(eq(attentionDismissal.ownerId, OWNER));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spaceId).toBe(DEFAULT_SPACE_ID);
    // The same key dismissed in each space is two independent rows.
    await service.dismiss(principalIn(SPACE_B), `digest:run-1:${SPACE_B}:0`);
    const both = await tdb.db
      .select()
      .from(attentionDismissal)
      .where(eq(attentionDismissal.ownerId, OWNER));
    expect(both).toHaveLength(2);
  });
});

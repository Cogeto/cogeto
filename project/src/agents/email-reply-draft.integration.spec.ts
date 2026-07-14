import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { EmailReplyDraftPayload, Principal } from '@cogeto/shared';
import { EMAIL_REPLY_DRAFT_ACTION } from '@cogeto/shared';
import { idempotentTask } from '../infrastructure/index';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { ActionRegistry } from './action-registry';
import { ApprovalService } from './approval.service';
import { ApprovalExecutor } from './approval.executor';
import { buildEmailReplyDraftAction } from './actions/email-reply-draft.action';
import { APPROVAL_EXECUTE_JOB_TYPE } from './domain/approval-machine';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: 'a@instance.test',
  orgId: 'org-1',
  orgName: 'Org One',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', orgId: 'org-1' }; // same org, different user

const draftPayload: EmailReplyDraftPayload = {
  to: 'ana@adriatic-foods.hr',
  recipientResolved: true,
  subject: 'Re: Delivery deadline',
  inReplyTo: '<orig@cogeto.test>',
  references: ['<orig@cogeto.test>'],
  body: 'Hi Ana,\n\nFriday works for the delivery. Talk soon.\n\nThanks',
  emailSourceId: 'email-1',
};

describe('email reply draft — approval finalises, never sends (integration)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let service: ApprovalService;
  let executor: ApprovalExecutor;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: 8,
        collection: 'reply-draft-spec',
      },
    });
    await store.ensureIndexReady();
    const registry = new ActionRegistry(store);
    service = new ApprovalService(tdb.db, registry);
    executor = new ApprovalExecutor(registry);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const taskList = (): TaskList => ({
    [APPROVAL_EXECUTE_JOB_TYPE]: idempotentTask(
      tdb.db,
      APPROVAL_EXECUTE_JOB_TYPE,
      async (tx, payload) => (await executor.execute(tx, payload.source_id)).afterCommit,
    ),
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: taskList() });

  it('reply_draft_no_send: the effect handler has NO send capability — it only finalises', async () => {
    // The action's effect is pure finalisation: no afterCommit (no external work
    // to reconcile), and the result explicitly records sent=false.
    const action = buildEmailReplyDraftAction();
    const result = await action.execute(
      null as never, // the effect touches no tx — it makes no external call
      { userId: userA.userId, orgId: userA.orgId },
      draftPayload,
    );
    expect(result.detail.sent).toBe(false);
    expect(result.detail.finalised).toBe(true);
    expect(result.afterCommit).toBeUndefined();
    expect(result.summary.toLowerCase()).toContain('not sent');
  });

  it('reply_draft_no_send: full approval flow finalises the draft and presents it for manual sending', async () => {
    const created = await service.create(userA, EMAIL_REPLY_DRAFT_ACTION, draftPayload);
    expect(created.status).toBe('pending_approval');

    // The draft is presented — copy-ready body, a mailto:, and a .eml. Never sent.
    const before = await service.getEmailDraft(userA, created.id);
    expect(before.sent).toBe(false);
    expect(before.status).toBe('pending_approval');
    expect(before.body).toContain('Friday works');
    expect(before.mailto.startsWith('mailto:')).toBe(true);
    expect(before.eml).toContain('To: ana@adriatic-foods.hr');
    expect(before.eml).toContain('Subject: Re: Delivery deadline');
    expect(before.eml).toContain('In-Reply-To: <orig@cogeto.test>');
    expect(before.eml).toContain('Friday works');

    // Owner-only: a same-org, different user cannot read the draft body.
    await expect(service.getEmailDraft(userB, created.id)).rejects.toThrow();

    // Approve → worker executes the finalisation.
    await service.confirm(userA, created.id, 'approve');
    await runWorker();

    const after = await service.getEmailDraft(userA, created.id);
    expect(after.status).toBe('executed');
    expect(after.sent).toBe(false); // STILL not sent — Cogeto has no send path

    // The execution audit is content-free (QS-1) and records sent=false — the
    // drafted body never enters the audit trail.
    const audit = await tdb.pool.query<{ detail: Record<string, unknown> }>(
      "SELECT detail_json AS detail FROM audit_log WHERE action = 'approval.executed' AND entity_id = $1",
      [created.id],
    );
    const detail = audit.rows[0]!.detail;
    expect(detail.sent).toBe(false);
    expect(JSON.stringify(detail)).not.toContain('Friday works'); // no body in audit
  });
});

import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { EMAIL_REPLY_DRAFT_ACTION } from '@cogeto/shared';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { approval } from './persistence/tables';

/**
 * A reply draft is derived from an email (its body is grounded on the erased
 * email + the user's memories) and is keyed by the email SOURCE id on the
 * approval payload — not by a memory id — so the memory-keyed cascades miss it.
 * Without this, deleting an email left the model-drafted reply readable on the
 * approvals surface while the signed receipt claimed complete erasure (SEC-4).
 *
 * On email-source deletion this redacts the drafted body (and subject/recipient)
 * of every reply-draft approval that referenced the source, to a deletion
 * marker — the chat-answer cascade's timeline-preserving redaction pattern
 * (QS-7). The row and its audit trail survive; only the derived content goes.
 * Idempotent: an already-redacted draft is not re-counted. Lives in the agents
 * module (it owns `approval`) and implements memory's DerivedCascade port; the
 * saga never touches this table itself (§A.1).
 */
const REDACTED_BODY = '[redacted: the email this reply was drafted from was deleted]';

@Injectable()
export class ReplyDraftCascade implements DerivedCascade {
  readonly artifact = 'reply_drafts';

  /** Reply drafts are not keyed by memory id — nothing to do on this arm. */
  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    // Only email sources have reply drafts (the payload's emailSourceId).
    if (sourceType !== 'email') return 0;
    const redacted = await tx
      .update(approval)
      .set({
        payloadJson: sql`${approval.payloadJson} || jsonb_build_object(
          'body', ${REDACTED_BODY}::text,
          'subject', ''::text,
          'to', ''::text,
          'recipientResolved', false,
          'recipientVerified', false
        )`,
      })
      .where(
        and(
          eq(approval.actionType, EMAIL_REPLY_DRAFT_ACTION),
          sql`${approval.payloadJson}->>'emailSourceId' = ${sourceId}`,
          // Idempotency: skip (and do not re-count) an already-redacted draft.
          sql`${approval.payloadJson}->>'body' IS DISTINCT FROM ${REDACTED_BODY}`,
        ),
      )
      .returning({ id: approval.id });
    return redacted.length;
  }
}

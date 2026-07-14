import { z } from 'zod';
import { EMAIL_REPLY_DRAFT_ACTION } from '@cogeto/shared';
import type { ActionDefinition } from '../action-types';

/**
 * Reply drafts (Session O4 — email source). Drafting a reply to an email is a
 * consequential action, but its effect is a NON-SENDING finalisation (roadmap
 * O4; the "send" seam realised as finalisation): on approval the draft is marked
 * finalised and presented to the user, who sends it from their own client.
 *
 * This effect has NO send capability by construction — no gateway call, no
 * network, no external write. It only records that the draft is finalised. The
 * draft itself (subject + body) is presented via GET /api/approvals/:id/email-
 * draft. The body lives on the approval payload (not the audit trail, which stays
 * content-free per QS-1).
 */
// All fields are required in the stored payload (the drafting service always
// sets them) — no zod defaults, so the schema's input and output types match and
// it satisfies ActionDefinition<P>'s invariant ZodType<P>.
const payloadSchema = z.object({
  // Empty when the recipient could not be recovered from a forward — the user
  // fills it in before sending (the forwarded-addressing rule).
  to: z.string().max(320),
  recipientResolved: z.boolean(),
  subject: z.string().max(998),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  body: z.string().min(1).max(20_000),
  emailSourceId: z.string().nullable(),
});
type EmailReplyDraftPayload = z.infer<typeof payloadSchema>;

/** Body preview lines for the Pending Approvals surface (bounded). */
function bodyPreview(body: string): string[] {
  const lines = body.split('\n').slice(0, 12);
  const preview = lines.map((l) => (l.length > 120 ? `${l.slice(0, 117)}…` : l));
  if (body.split('\n').length > 12) preview.push('…');
  return preview;
}

export function buildEmailReplyDraftAction(): ActionDefinition<EmailReplyDraftPayload> {
  return {
    actionType: EMAIL_REPLY_DRAFT_ACTION,
    schema: payloadSchema,
    initialStatus: 'pending_approval',
    ttlSeconds: 7 * 24 * 60 * 60, // a week to send it (or not)
    summarize: (p) =>
      p.recipientResolved ? `Draft reply to ${p.to}` : 'Draft reply (set recipient)',
    preview: (p) => [
      p.recipientResolved ? `To: ${p.to}` : 'To: (recipient not recovered — set it before sending)',
      `Subject: ${p.subject || '(no subject)'}`,
      '—',
      ...bodyPreview(p.body),
      '—',
      'Cogeto does NOT send email. Approving finalises this draft for you to copy,' +
        ' download as .eml, or open in your own mail client and send yourself.',
    ],
    // No authorizeCreate: the drafting service creates it for the owner over
    // their own email source (owner-checked there); the payload carries no ids
    // that could target another user's data.
    execute: async (_tx, ctx, p) => {
      // Finalisation ONLY — deliberately NO send path. The draft is now ready for
      // the user to send from their own client; the effect makes no external
      // call. Audit detail stays content-free (QS-1): counts/booleans, never the
      // drafted body (which lives on the owner-gated approval payload).
      return {
        summary: `Reply draft to ${p.to} finalised — not sent (send it from your own client)`,
        detail: { recipient: p.to, finalised: true, sent: false, requestedBy: ctx.userId },
      };
    },
  };
}

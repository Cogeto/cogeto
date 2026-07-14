# Email as a first-class source (Session O4 — email source)

This is the second half of email (Unit B). Unit A ([`email-inbound.md`](email-inbound.md),
[decision 0028](../decisions/0028-inbound-email-design.md)) shipped the receive-only
Haraka server, the allowlist-gated intake, and full retention. This unit makes
email a **first-class source**: thread-aware extraction, full deletion coverage,
reply drafts through the approval machine (no sending), a forwarding-setup UI, and
email golden cases.

## What shipped

### 1. Thread-aware extraction

Before an email body is extracted, `isolateEmailContent` (ingestion) isolates the
**new content of that message**:

- **Quoted history** is dropped (cut at the attribution line — "On … wrote:",
  "-----Original Message-----", Croatian "Dana … je napisao:" — and `>`-quoted
  lines removed). Prior messages in a thread are already their own sources, so
  re-extracting quoted text is wasteful and a duplication source.
- **Signatures** are stripped (the RFC 3676 `-- ` delimiter; trailing device
  sign-offs).
- **Forwarded messages**: when a body IS a forwarded original, the **innermost
  forwarded content** is extracted (cover note + forward header stanza dropped);
  provenance stays with the carrying email.

Deterministic and model-free — a delimiter cut is more reliable than asking a
prompt to abstain on quoted text, so no extraction-prompt change was needed. The
same function runs in the email `SourceReader` (production) and in the golden-set
harness for `source_type: "email"` cases, so both isolate identically.

### 2. Deletion coverage (honours the F1 saga)

`requestSourceDeletion(principal, 'email', <id>)` now fully covers an email
source. The `SourceDeletion` port gained an optional `enumerateCascade`, which the
saga folds into the ONE enumeration transaction and the ONE receipt (no receipt-
schema change, no new deletion path):

- the `email_message` row (attachments cascade via FK),
- the raw original object + the retained sanitised-HTML object (when externalised),
- each **attachment file source** — its `file_metadata`, its object, and its
  derived memories,
- the body-derived memories.

The receipt counts every memory id and object key; the worker deletes points +
objects (absent = success); the chain verifies and the nightly sweep finds zero
residue. Covered by `email_deletion_cascade`.

### 3. Reply drafts through approval (no sending)

`POST /api/email/:id/reply-draft` drafts a reply to an email you own: retrieval
assembles context (what you know about the sender, open loops), the answer tier
drafts the body, and the draft is created as an `email_reply_draft` **consequential
action** in the approval machine. On approval the effect **finalises** the draft —
it has **no send capability** by construction. The finalised draft is presented via
`GET /api/approvals/:id/email-draft` (copy body, download `.eml`, or open a
prefilled `mailto:`), for you to send from **your own client**. The drafted body
lives on the (owner-gated) approval payload; the audit trail stays content-free.
Covered by `reply_draft_no_send`.

### 4. Forwarding-setup UI

**Settings → Email capture** shows the instance's inbound address with copy-to-
clipboard, provider-agnostic instructions for the three ways to use it (forward a
message, BCC on send, a provider-side auto-forward rule), and a plain statement of
what Cogeto does and does not receive (only what you forward — never your whole
mailbox, never your password or account access). The sender allowlist (the control
that decides whose mail is remembered) lives right below it.

### 5. Email golden cases

8 email cases (4 en, 4 hr): threaded latest-only, forwarded, an email commitment
(→ task), and a two-email contradiction (feeds dreaming). See the golden
[`CHANGELOG`](../../project/eval/golden/CHANGELOG.md).

## Demos

### Forward a thread

1. In **Settings → Email capture**, allowlist a sender/domain (e.g. your own
   address, or `adriatic-foods.hr`).
2. Forward a real thread to the inbound address (locally, use
   `node scripts/dev/send-test-email.mjs` — see [`email-inbound.md`](email-inbound.md)).
3. Only the **latest** message's new content is remembered; quoted history and
   signatures do not produce memories. Forward a "FYI" with an inline forwarded
   original and the **inner** commitment is what lands.

### Draft a reply

1. `POST /api/email/<emailId>/reply-draft` (the chat/email UI's "draft a reply"
   affordance) → an `email_reply_draft` appears in **Approvals**, showing the
   drafted subject + body.
2. Approve it → it is **finalised, not sent**. Use **Copy body**, **Download
   .eml**, or **Open in mail client** to send it yourself. The UI states plainly
   that Cogeto does not send mail.

## Owner verification checklist

- [ ] A forwarded thread remembers only the latest message's new content; quoted
      history and the signature are not extracted.
- [ ] A "FYI"-forwarded original remembers the innermost forwarded content, with
      provenance to the email that carried it.
- [ ] Deleting an email source (with an attachment) removes the row, the raw +
      HTML objects, the attachment file source (object, metadata, memories), and
      the body memories; the receipt counts them and verifies; the sweep is clean.
- [ ] Drafting a reply creates a pending approval; approving it finalises a
      copy-ready draft and **sends nothing**; the draft downloads as a valid `.eml`.
- [ ] Settings → Email capture shows the inbound address with copy, the three
      usage instructions, and the "only what you forward" statement.
- [ ] `npm run eval` (extraction + reconcile) runs the new email cases with no
      gate regression (live gate runs on push to `main`).

## Named tests

`quote_stripping`, `forwarded_message` (ingestion `email-preprocess.spec`);
`email_deletion_cascade` (memory); `reply_draft_no_send` (agents); `thread_dedup`
(connectors). Plus the Unit A email intake/allowlist suites.

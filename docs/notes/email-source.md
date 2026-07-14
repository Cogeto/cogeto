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

---

## Making reply drafting usable (Session O4 — email reply triggers)

The reply-drafting capability (below) is now reachable the two ways a person
expects: **from the email itself** and **from chat**. Plus a faithful reading
view so you can see what you're replying to.

### The email reading view

`GET /api/email/:id/source` renders the full retained message in the source
drawer: sender, recipients, date, subject, body, attachments (downloadable when
they're a stored file source), and — for a forward — the recovered original
correspondent ("Originally from: Ana Kovač <ana@…>"). **UX/safety choice:** the
body renders the **text/plain** part by default (safe, faithful); HTML-only mail
falls back to the sanitised HTML with **remote content neutralised** (no tracking
pixels auto-load) — the choice mail clients make and the hardest to misuse. The
intake sanitiser already strips scripts/handlers/`javascript:` URLs; the drawer
additionally blocks remote `src`/`srcset`/`url()`.

### Forwarded-message reply addressing (the core correctness rule)

Cogeto receives email by forwarding, so when you forward Ana's message to Cogeto
the envelope/header From becomes **you**, and Ana sits in the body as a forwarded
block. A naïve "reply to this" would address the reply to yourself. So the reply
recipient is **recovered from the forwarded content**, with this precedence
(documented so both triggers behave identically):

1. **The recovered forwarded original From** — a forwarded block in the body
   names the real correspondent (manual forward). Reply to them; thread on the
   original subject + Message-ID.
2. **The message's own From**, when it's a plausible external sender (not the
   capture user). This covers directly received mail **and** provider-side
   auto-forward / BCC, which preserve the original sender on the message itself —
   so those address correctly with no body parsing.
3. **Otherwise unset** — a self-forward whose original couldn't be recovered
   leaves the recipient blank for you to fill in, rather than guessing or
   replying to yourself. The draft is still created; the UI/chat prompt you to
   set the recipient.

`resolveReplyTarget` implements this; `parseForwardedHeaders` recovers the
en/hr forwarded header stanza. The resolved reply-to is recorded on the draft, so
the drawer button and the chat trigger produce identical addressing.

### The two triggers

- **Email-drawer "Draft reply" button** (the reliable, discoverable path) — on an
  email source only (never notes/files/chat). It states plainly that Cogeto will
  write a suggested reply you edit and send yourself, gives immediate feedback,
  and points you to the pending draft in Approvals. **UX choice:** a single
  button with a great default ("reply appropriately from context"), not a form —
  the optional one-line steer lives on the API (`{ intent }`) for callers that
  want it, but the drawer keeps it one click.
- **Chat intent** — `detectEmailReplyIntent` (deterministic, in the
  query-understanding layer; reuses the rewriter's entities for the target)
  recognises "draft a reply to Ana's last email", "reply to Marko", "help me
  answer Ana", and the Croatian equivalents. It resolves the target against your
  recent emails and behaves like a thoughtful assistant: **one confident match →
  drafts** and confirms with a pointer to Approvals; **an ambiguous named request
  → lists the candidates and asks** (creates nothing); **no match → declines**
  and points to the drawer button. It's fast-path: no ingestion work, no sending
  — it only creates the draft through the existing approval path. Cross-module
  wiring is a port (`CHAT_REPLY_RESOLVER`): retrieval defines it, connectors
  implements it, the app root binds it — ChatService never imports connectors.
  **UX note:** the chat confirmation is deterministic text (not model output) and
  references the **Approvals** page (chat renders plain text by design).

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

### Draft a reply from the drawer / from chat (Session O4 triggers)

- **From the email:** open an email memory's source drawer → read the message →
  click **Draft reply** → you're pointed to the pending draft in **Approvals**.
- **From chat:** type *"draft a reply to Ana's last email"* (or *"reply to
  Marko"*, or the Croatian *"napiši odgovor…"*). Cogeto resolves the email, drafts
  it, and confirms with a pointer to Approvals. Try an **ambiguous** request
  (several emails from the same person) and it lists them and asks instead of
  guessing.
- Either way the draft lands in **Approvals** with the "Cogeto does not send"
  notice and the copy / `.eml` / mail-client options. A **forwarded** message
  addresses the reply to the recovered original correspondent, not the forwarder.

## Owner verification checklist

- [ ] A forwarded thread remembers only the latest message's new content; quoted
      history and the signature are not extracted.
- [ ] The email drawer shows the message readably (sender, recipients, date,
      subject, body, attachments); a forwarded message shows "Originally from: …".
- [ ] **Draft reply** on the drawer creates a draft and routes to Approvals.
- [ ] Chat: naming a sender drafts a reply and confirms; an ambiguous request
      asks (lists candidates) rather than guessing; a no-match declines cleanly.
- [ ] A **forwarded** email's drafted reply is addressed to the original
      correspondent (Ana), not the forwarder; an unrecoverable one leaves the
      recipient blank with a prompt to set it.
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

Email as a source (earlier units): `quote_stripping`, `forwarded_message`
(ingestion `email-preprocess.spec`); `email_deletion_cascade` (memory);
`reply_draft_no_send` (agents); `thread_dedup` (connectors).

Reply triggers (this unit): `forwarded_reply_addressing` (connectors
`email-reply-target.spec` + `email-reply-triggers.integration`),
`reading_view_faithful` + `reply_button_creates_draft`
(`email-reply-triggers.integration`), `chat_reply_intent` + `fast_path_clean` +
`no_send_preserved` (retrieval `chat-reply-intent.integration`), plus
`detectEmailReplyIntent` + `parseForwardedHeaders` unit tests. Golden chat-eval:
`reply_to_ana` (en) + `reply_hr_zadnja` (hr).

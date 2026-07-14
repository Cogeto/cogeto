# 0028 — Inbound email: per-tenant Haraka, allowlist-gated, receive-only, fully retained

**Status:** Accepted. **Context:** Session O4 (email) per
[`docs/Cogeto-v1-Roadmap-Revision.md`](../Cogeto-v1-Roadmap-Revision.md) D2:
email arrives by **forwarding** into a per-tenant, **receive-only** Haraka SMTP
server that drops accepted mail onto the existing ingestion pipeline. Cogeto
never holds mailbox credentials and never reads a whole inbox; no OAuth, no
CASA, no publisher verification. This record freezes the design decisions for
the inbound path (Unit A: addressing, trust model, intake, retention,
anti-abuse). Sending, the deletion-saga coverage of email sources, and the
forwarding-setup guidance UI are **Unit B** and are noted where relevant but not
decided here.

This record uses `source_type = 'email'` (already present in the `source_type`
enum, migration 0001). Every derived memory carries provenance `('email',
<email_message.id>)` (§A.6). New dependency **mailparser** (a maintained MIME
parser) is authorized by the owner in the O4 task brief — recorded here per the
"new dependency needs sign-off" rule (CLAUDE.md); it is imported only by the
connectors intake.

## Ruling 1 — Addressing: a unique per-tenant inbound address on the instance's own subdomain

1. **Format.** Each instance owns a single inbound address on its own subdomain:
   `capture@in.<instance>.cogeto.eu` (e.g. `capture@in.acme.cogeto.eu`). The
   local-part is the fixed literal `capture`; the tenant is encoded in the
   **subdomain**, never in a shared central domain. Mail for a tenant only ever
   reaches that tenant's Haraka container because the tenant's `in.<instance>`
   MX record points at that box (the DNS/MX wiring is an O6 provisioning
   concern; this record fixes the *scheme*, O6 automates the records).
2. **No central inbound domain.** There is deliberately no shared `@in.cogeto.eu`
   relay that fans mail out to tenants — that would put every tenant's mail
   through shared infrastructure, defeating the single-tenant isolation that is
   the whole security argument (decision 0019). Isolation is by **deployment
   boundary**: one box, one Haraka, one address.
3. **The instance knows its own address by configuration.** The address is set
   at provision time as `COGETO_MAIL_INBOUND_ADDRESS` (the exact accepted
   recipient) and surfaced read-only in the UI (Settings → Email capture). The
   Haraka container is configured with the same value so recipient validation
   and the app agree on one source of truth. A fresh instance with no configured
   address rejects all recipients (closed by default).

## Ruling 2 — Trust model: the user-managed sender allowlist is the primary acceptance control

The forwarding model cannot authenticate the *original* sender — a forwarded or
BCC'd message arrives from the user's own mail provider, and the header `From`
can be spoofed. So sender *authentication* is not the control. The controls, in
layers, are:

1. **Per-tenant isolation** (deployment boundary) — a message can only ever reach
   the one tenant whose MX points at the box.
2. **Recipient validation** — only the instance's configured address is accepted;
   everything else is refused at SMTP `RCPT`.
3. **The sender allowlist — the primary acceptance gate.** A message is accepted
   only if its matched sender is present on the user-managed allowlist. All other
   mail is refused before any pipeline work and nothing is stored.
4. **Anti-abuse hygiene underneath** — size caps, attachment-size caps, and
   per-connection/per-sender rate limiting (Ruling 6).

### 2a — What "matched sender" means (frozen)

- **Match target.** Matching uses the **verified envelope sender** (SMTP
  `MAIL FROM`) where available, and falls back to the **header `From`** address
  when the envelope sender is empty (e.g. some auto-forwarders send a null
  return-path). Both are normalized (lower-cased, angle-brackets/display-name
  stripped, to `local@domain`) before comparison.
- **Entry kinds — both address and whole-domain are supported.**
  - `address` entries match the full normalized address exactly
    (`ana@adriatic-foods.hr`).
  - `domain` entries match any address whose domain equals the entry
    (`adriatic-foods.hr` or `@adriatic-foods.hr`, stored normalized as the bare
    domain). Subdomains are **not** implicitly included — `adriatic-foods.hr`
    does not match `sales.adriatic-foods.hr`; the user adds the subdomain
    explicitly. This keeps the gate predictable.
- **Spoofing limitation, documented deliberately.** In a pure forwarding model
  the envelope sender and header `From` can both be forged, so the allowlist is
  an *acceptance-scoping* control ("whose mail may Cogeto remember"), **not** an
  anti-impersonation control. It is defensible precisely because it is layered on
  per-tenant isolation: the blast radius of a spoofed allowlisted sender is one
  tenant's own memory, populated with content the tenant already chose to trust
  by allowlisting that sender/domain. We do not add SPF/DKIM verification as an
  acceptance gate in v1 (a possible later hardening); it is noted, not required.

### 2b — Default state: closed

The allowlist is **empty by default**, and an empty allowlist accepts **no**
external mail. A fresh instance is closed until the user adds at least one sender
or domain. The Settings copy states this plainly: until you add senders, no
forwarded mail is accepted.

## Ruling 3 — Owner mapping: v1 is single-user; the capture owner is resolved deterministically

1. **v1 rule.** A single-user instance attributes every accepted message to its
   one owner. The intake resolves the **capture owner** via the identity
   directory: if `COGETO_MAIL_CAPTURE_USER_EMAIL` is configured, the owner is the
   directory user with that email; otherwise, when the directory holds exactly
   one user, that user is the owner. If neither resolves (zero or ambiguous
   users, no configured email), the message is **refused** (recorded as a
   refusal, reason `no_owner`) rather than guessed — no memory without a real
   owner (§A.6).
2. **Multi-user extension (noted, not built).** For a shared instance the v1.x
   path is either a **per-user inbound address** (a distinct local-part or
   subdomain label per user, resolved to that user) or a **default capture user**
   chosen in Settings. The schema already carries `owner_id` on every email row,
   so this extension needs no migration — only a richer resolver. Frozen for v1:
   single owner.

## Ruling 4 — Sending is out of scope; the server is receive-only

The Haraka container has **no outbound/relay capability** — it is explicitly
disabled (no `outbound` processing, no relay for any client, the queue hook only
delivers inbound mail to the app over HTTP). Cogeto never sends email. Reply
drafts are a **Unit B** feature handled through the approval machine (§A.8) and
surfaced for the user to send from their own client; nothing in the inbound path
sends.

## Ruling 5 — Full retention of every accepted message (deliberate)

1. **What is retained.** Every accepted message is stored **in full**: the parsed
   header set (`headers_json`), the `text/plain` body, the sanitised `text/html`
   body (retained for display and future use), all attachments, and the **raw
   original** RFC822 in MinIO under the scoped, encrypted (SSE) key scheme. The
   `email_message` row plus the raw object constitute the complete retained
   message. This corpus is **owned by the connectors module** (its own tables +
   objects reached through the memory module's object-store port, decision 0003
   ruling 2), distinct from the derived memories.
2. **Why.** Extraction is one *consumer* of the message, not the point of storage.
   Retaining the complete history lets later features derive additional value
   (thread reconstruction, re-extraction under improved prompts, richer source
   drawers) without asking the user to forward again.
3. **Governance.** The retained corpus respects `scope` (default `private`) and
   the `sensitive` flag exactly like every other source, and is **subject to the
   same deletion and export guarantees** as all other data. The deletion saga
   coverage of email sources and their receipts (the raw object, the HTML object,
   the row, the attachment file-sources, and the derived memories) is **Unit B** —
   until it ships, the UI does not offer email-source deletion. The schema is
   built deletion-ready (object keys recorded on the row so the saga can enumerate
   them).
4. **Extract-and-discard interaction.** If extract-and-discard (§A.9) is later
   applied to an email or an attachment, that mode still removes the raw original
   per its contract while retaining the derived memories — the retention default
   here does not override the discard mode a user explicitly chose.

## Ruling 6 — Anti-abuse hygiene for an internet-facing receive-only server

Layered *underneath* the allowlist (which is the real acceptance gate), the
following knobs guard an internet-facing SMTP endpoint. Sane defaults, all
configurable:

| Knob | Default | Enforced at |
| --- | --- | --- |
| Max message size | 25 MB | Haraka (`DATA` size cap → SMTP 552) + app backstop |
| Max total attachments size | 25 MB | app intake (refuse over cap) |
| Recipient validation | instance address only | Haraka `RCPT` (→ SMTP 550) |
| Per-connection concurrency | 3 | Haraka `limit` plugin |
| Per-remote-host rate | 30 msgs / 60 s | Haraka `limit` plugin |
| Allowlist acceptance | closed by default | app intake (authoritative), surfaced at SMTP via the queue-hook HTTP verdict |

These are **hygiene**, not a full anti-spam stack. We deliberately do not add
content spam scoring, greylisting, or RBL checks in v1 — the allowlist makes them
redundant for acceptance (only known senders are accepted at all). Noted as
possible later hardening.

## Ruling 7 — Enforcement placement: one authoritative check, surfaced at SMTP time

The allowlist + recipient + owner checks are enforced **authoritatively in the
app intake** (a single code path, unit-tested), not duplicated into Haraka.
Haraka's queue hook calls the intake over an **internal authenticated HTTP
endpoint** (shared-secret bearer, internal network only — never public) and
translates the intake's HTTP verdict into the SMTP response: `2xx` → `250 queued`,
`403` (allowlist/owner refusal) → `550`, `413` (too large) → `552`, `5xx` →
transient/permanent per status. This gives the sending server a **clear SMTP
refusal during the transaction** (the roadmap's preference) while keeping the
acceptance logic in one authoritative place. Cheap pre-filters (recipient, size,
rate) still run at Haraka before the app is called. A refused message stores
**nothing**: only a metadata-only refusal row (sender, time, reason — no body).

## Ruling 8 — Transactional intake (the safe order, mirroring file upload)

Intake follows the frozen file-upload safe order (F1 handoff, decision 0025):

1. Parse the RFC822 (mailparser). Enforce allowlist/recipient/owner/size — refuse
   before any write on failure (metadata-only refusal log).
2. **Object-first**: PUT the raw original, the sanitised HTML (if any), and each
   supported attachment's bytes to MinIO under minted scoped keys.
3. **One transaction**: insert the `email_message` row, the `email_attachment`
   rows, the `file_metadata` rows for supported attachments (via the memory
   port), and enqueue — through the outbox — the email-body pipeline job
   (`source_type 'email'`) plus one file-pipeline job per supported attachment
   (`source_type 'file'`). All commit together.
4. On abort, a compensating delete removes every object written in step 2 (logged,
   retried; the nightly sweep's orphan arm is the backstop). A failed intake
   leaves no source, no job, and no orphaned object.

Supported attachment types (`application/pdf`, DOCX) become their own **linked
file sources** in the document pipeline; unsupported attachments are **recorded**
(an `email_attachment` row) but **not processed** — their bytes remain within the
retained raw original.

## Consequences

- A fresh instance is **closed by default**; the user opens it by allowlisting
  senders/domains in Settings, which is audited.
- The allowlist is an acceptance-scoping control, not sender authentication; its
  safety rests on per-tenant isolation. This is stated in the UI and here.
- Full retention is a deliberate storage choice with the same deletion/export
  guarantees as all data; the deletion-saga coverage lands in Unit B.
- One new dependency (`mailparser`), owner-authorized in the O4 brief, imported
  only by connectors.
- The MX/TLS/DNS requirements for operators are documented in
  [`docs/notes/email-inbound.md`](../notes/email-inbound.md) and handed to O6 for
  provisioning automation.

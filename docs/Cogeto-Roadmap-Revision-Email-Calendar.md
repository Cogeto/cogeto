# Cogeto — Roadmap Revision: Email & Calendar

> **Status: SUPERSEDED / folded into [`Cogeto-v1-Roadmap-Revision.md`](Cogeto-v1-Roadmap-Revision.md) (BINDING).**
> This is the earlier working note in which the email and calendar decisions were
> first worked out. Those decisions now live — in final, locked form — in the v1
> Roadmap Revision, which also adds the operations (D3/D4) and v1-scope-lock (D5)
> decisions. **Where this note and the v1 Roadmap Revision disagree, the Revision
> wins. Only the latest revision governs.** This file is kept for provenance and as
> the resolved cross-reference; do not plan against it directly — read the Revision.

## Why this note exists

The main [`Cogeto-v1-Roadmap-Revision.md`](Cogeto-v1-Roadmap-Revision.md) "folds in the
email and calendar decisions from" this document. The substance below is preserved so
that reference resolves; the canonical, binding statements are D1 and D2 in the Revision.

## The two decisions (final form in the Revision as D1 and D2)

### Calendar — dropped from v1 (Revision D1)
Calendar entries are triggers, not sources of durable facts; the commitments and
decisions Cogeto exists to remember live in notes and email. Meeting invites already
arrive as email and flow in through the forwarding path for free; meeting prep is
answered from existing memory about the person. Calendar is **removed from v1 entirely
and is not on the v1.x list**. It may be reconsidered only if real design-partner
demand appears, as a proper connector, **post-2.0**. (This replaces the earlier
Notes → Calendar → Email sequencing.)

### Email — receive-only Haraka forwarding, no OAuth (Revision D2)
Cogeto never holds mailbox credentials and never reads a whole inbox. Each instance
exposes a unique inbound address; the user forwards, BCCs, or sets a provider-side rule
to send relevant mail to it. A **receive-only Haraka SMTP server** runs as one more
container inside the single-tenant deployment, accepts mail for that instance, and drops
it onto the existing ingestion pipeline as `source_type 'email'`. **No OAuth, no CASA,
no Gmail scope assessment, no publisher verification** on the launch path; it works with
every provider; email data never leaves the tenant's box. **Sending is out of scope:**
reply drafts go through the approval machine and are surfaced for the user to send from
their own client. Addressing is **per-tenant** — mail for a tenant only ever reaches
that tenant's Haraka container; there is no central inbound domain. (This replaces the
earlier "email via Microsoft Graph + IMAP, Gmail per the CASA decision" plan.)

## What the Revision adds on top of this note

- **D3** — operations are script-driven and manual-by-design (one operator script + a
  printed TODO checklist; no Terraform / API automation / self-serve / auto-updates).
- **D4** — no trials automation, no monitoring stack, no backup scripts in v1.
- **D5** — the v1 feature set is locked; the remaining sessions are **O4–O7**
  (O4 email via Haraka, O5 time-travel diff UI + Memory Passport, O6 operator script +
  runbook, O7 launch gate). Local embeddings and other items are deferred to 2.0+.

For anything beyond the two decisions above, and for the authoritative, current plan,
read **[`Cogeto-v1-Roadmap-Revision.md`](Cogeto-v1-Roadmap-Revision.md)** — it is the
one that wins.

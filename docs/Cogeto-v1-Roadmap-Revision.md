# Cogeto — v1 Roadmap Revision (Email, Operations, and v1 Scope Lock)

**Status: BINDING.** Place in Confluence as a revision, and in the repo at `docs/Cogeto-v1-Roadmap-Revision.md`. This document supersedes the O4/O5/O6 rows and the v1.x list in `docs/Cogeto-Model-Split-Roadmap.md`, and folds in the email and calendar decisions from `docs/Cogeto-Roadmap-Revision-Email-Calendar.md`. Where this document and any earlier plan disagree, this document wins. Each decision below should also get its own short decision record when its session runs.

Everything through O3 and the security fix sessions (FIX-1/2/3) is complete: the memory core, deletion receipts, dreaming, temporal retrieval, tasks, files, approvals, shared scope, chat capture, the Ana sandbox, the redaction sidecar, the design pass, and the full security hardening pass. What remains for v1 is defined below.

---

## Locked decisions

### D1 — Calendar is dropped from v1 (and not planned)
Calendar entries are triggers, not sources of durable facts; the commitments and decisions Cogeto exists to remember live in notes and email. Meeting invites already arrive as email and flow in through the forwarding path for free. Meeting prep is answered from existing memory about the person. Calendar is removed from v1 entirely and is not on the v1.x list; it may be reconsidered only if real design-partner demand appears, as a proper connector, post-2.0.

### D2 — Email arrives by forwarding into a per-tenant Haraka server
Cogeto never holds mailbox credentials and never reads a whole inbox. Each instance exposes a unique inbound address; the user forwards, BCCs, or sets a provider-side rule to send relevant mail to it. A receive-only Haraka SMTP server runs as one more container inside the single-tenant deployment, accepts mail for that instance, and drops it onto the existing ingestion pipeline. No OAuth, no CASA, no publisher verification on the launch path; works with every provider; email data never leaves the tenant's box. Sending is out of scope: reply drafts go through the approval machine and are surfaced for the user to send from their own client. Addressing is per-tenant (mail for a tenant only ever reaches that tenant's Haraka container); no central inbound domain.

### D3 — Operations are script-driven and manual-by-design, not automated infrastructure
No Terraform, no cloud-provider API automation, no self-serve provisioning, no automatic updates. One good operator script, run by hand on a fresh OVHcloud Ubuntu instance, handles install, configuration, and upgrades. The script does what it can automatically, then prints a precise, structured checklist of what the operator must do (DNS records, OVH settings, verification steps). This is the correct scope for the first cohort of customers and will not be expanded until manual onboarding is the actual bottleneck (a post-2.0 consideration).

### D4 — No trials, no monitoring stack, no backup scripts in v1
Trials are tracked manually by the operator until client volume justifies automation. Monitoring is deferred (a possible private, self-built system later). Backups use OVHcloud's own backup capability, configured by the operator in the OVH panel, not a Cogeto script; the operator runbook documents exactly what to enable. Restore is rehearsed manually and documented.

### D5 — v1 feature set is locked
v1 includes everything already built, plus: email via Haraka (D2), the operator script and runbook (D3), the time-travel diff UI, the Memory Passport, the trust-score public page, the compliance one-pager, and OSS launch preparation. v1 excludes: calendar, local embeddings (planned for 2.0), trials/monitoring/backup automation (D4), and the dreaming digest chat card (remains a later item unless trivially free during the design work).

---

## Remaining v1 sessions

| # | Session | Scope | Model |
|---|---|---|---|
| O4 | Email via Haraka (per-tenant, receive-only) | Haraka container in the deployment; unique per-instance inbound address; inbound parsing (headers, body, attachments, and calendar-invite parts within emails) into the existing pipeline as source_type 'email'; thread-aware extraction avoiding re-extraction of quoted history; provenance to the message; the deletion saga covers email sources and their receipts; reply drafts through the approval machine surfaced for the user to send from their own client; spam/abuse basics for a receive-only server; the inbound address shown in the UI with forwarding-setup guidance; email golden cases (en/hr) | Opus 4.8 |
| O5 | Time-travel diff UI + Memory Passport | The temporal engine already exists (F3); this builds the visual diff: a per-entity/per-project timeline of how knowledge changed, each change linked to its causing source, with point-in-time and change views surfaced in the dashboard. The Memory Passport: one-click export of all facts, statuses, provenance, validity history, and deletion receipts in a documented, versioned open format, with the schema published; export only (import is post-v1) | mixed (diff UI Opus; Passport format/export Opus, with any temporal-edge reasoning to Fable if needed) |
| O6 | Operator script + runbook | One script for a fresh OVHcloud Ubuntu instance with subcommands (install, configure, upgrade, and a status/verify check): installs Docker and dependencies, pulls Cogeto, generates per-tenant secrets and the Haraka inbound address, brings the stack up, sets up TLS via Let's Encrypt as the website already does, and on upgrade pulls the new version, runs migrations, and restarts. It performs everything it safely can, then prints a structured, checkbox-style TODO of operator actions: exact OVHcloud DNS records to add (A record for the app, MX for the instance's Haraka inbound, SPF/PTR notes for inbound mail), the OVHcloud backup settings to enable (per D4), and a verification list (login works, inbound test email lands, receipt exports, health green). A companion operator runbook documents the whole per-customer onboarding, the manual trial tracking, the OVH backup configuration and rehearsed restore, and the upgrade procedure. No Terraform, no API automation | Opus 4.8 |
| O7 | Launch gate | The trust-score public page (per-release eval metrics published); the compliance one-pager (data residency, encryption posture, sample deletion receipt, subprocessor list, GDPR/AI-Act mapping); OSS launch preparation (CONTRIBUTING with the CLA flow, SECURITY disclosure policy, README polish, repository launch checklist); and re-running BOTH the gap audit and the security audit as the final launch check. Passing this gate means v1 is launchable | Opus 4.8 (audits re-run may use Fable) |

**Four sessions to launch: O4 email, O5 time-travel + passport, O6 operator script, O7 launch gate.**

---

## What launch looks like (definition of done for v1)

- A stranger can be onboarded by the operator running one script on a fresh OVHcloud instance and following its printed checklist, reaching a working, TLS-secured, single-tenant Cogeto with a live email inbound address, in well under an hour.
- The customer captures notes, forwards email, uploads files; Cogeto remembers, verifies, consolidates (dreaming), tracks open loops, answers with sources, and shows knowledge changing over time (time-travel diff).
- The customer can inspect and correct everything, provably delete any source and receive a signed receipt, and export everything via the Memory Passport.
- The operator can upgrade an instance by running the script's upgrade subcommand, and restore from an OVHcloud backup by a rehearsed procedure.
- The public trust-score page and compliance one-pager are live; the open-source repository is launch-ready.
- Both audits pass.

---

## v2.0 and beyond (explicitly deferred, not forgotten)

Local embeddings and a local utility-LLM tier behind the model gateway; operational automation (Terraform/OVH API provisioning, self-serve trials, a monitoring stack) once manual onboarding becomes the bottleneck; Memory Passport import; the dreaming digest chat card; a proper calendar connector if design-partner demand proves real; further connectors; envelope encryption; enterprise depth and formal certifications.

---

## How to apply this document

A future Claude Code session should read this file and update the affected planning docs to match: revise the O4/O5/O6 rows and the v1.x list in `docs/Cogeto-Model-Split-Roadmap.md` to the O4-O7 sessions and the v1 scope above; ensure `docs/Cogeto-Roadmap-Revision-Email-Calendar.md` is consistent (this document extends it with the operations decisions D3/D4 and the v1 lock D5); and note in the development plan that calendar is removed and local embeddings deferred to 2.0. Do not change code in that session; documentation only, and flag any contradiction with existing decision records for owner review.

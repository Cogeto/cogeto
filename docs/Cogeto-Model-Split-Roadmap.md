# Cogeto — Model-Split Roadmap (Fable 5 now, Opus 4.8 later)

**Status: BINDING for session planning.** Place at `docs/Cogeto-Model-Split-Roadmap.md`. Supersedes the session numbering S4/S4.5+ in earlier plans; the gap-audit findings (docs/audits/implementation-gap-audit.md) are folded in. Principle: Fable 5 does everything where subtle correctness or model calibration lives; Opus 4.8 executes precisely specified work. Every Fable session ends with a frozen handoff spec in `docs/handoff/` that the corresponding Opus session implements against without redesigning.

> **Superseded for O4–O7 and the v1.x list by [`docs/Cogeto-v1-Roadmap-Revision.md`](Cogeto-v1-Roadmap-Revision.md) (BINDING).** The Opus rows O4/O5/O6 below have been replaced with the O4–O7 sessions from the revision; the old v1.x list has been replaced by the locked v1 scope + 2.0 deferrals. Calendar is dropped from v1 (and not on the v1.x list); local embeddings are deferred to 2.0. F1–F3 and O1–O3 (plus the security fix sessions FIX-1/2/3) are complete and left intact.

## Fable 5 block (run now, in order; priority F1 > F2 > F3)

| # | Session | Scope | Handoff produced |
|---|---|---|---|
| F1 | Deletion saga + receipts | MinIO SSE configured (+ .env.example correction); five-step saga across Postgres/Qdrant/MinIO; hash-chained signed receipts; nightly orphan sweep; Forgotten section; cascade DoD test against notes + a seeded object | docs/handoff/F1-deletion-saga.md (how O1 file uploads plug into the saga) |
| F2 | Reconcile + dreaming + gates | Stage 6 real: dedup, contradiction (makes `contradicted` reachable), supersession/staleness; dreaming nightly cycle + plain digest; verification/v0003 (Croatian contrast, hr agreement was 57.1%); dedup/contradiction golden cases + harness scoring; CI eval gate ON; corpus ~30en/15hr | docs/handoff/F2-dreaming.md (digest card contract for later UI) |
| F3 | Temporal + tasks core | Temporal retrieval mode (lift outdated/replaced on explicit temporal queries); task-derivation engine (commitment/open-loop memories → structured tasks with conditions and closure detection) + prompts + eval cases | docs/handoff/F3-tasks.md (tasks UI, reminders, digest spec for O2) |

## Opus 4.8 block (later, in order)

| # | Scope | Depends on |
|---|---|---|
| O1 | File upload UI + PDF/docx extraction into the pipeline; extract-and-discard + minimal Settings; wire uploads into F1 saga (extend cascade tests to real files); approval state machine end to end (+ approval-gate test); audit-log reader + UI panel; env/doc hygiene | F1 |
| O2 | Tasks UI, reminders, daily digest per F3 handoff; shared-scope selector + org second-user flow; chat-derived memory capture; identity + gateway seam tests | F3 |
| O3 | Ana sandbox (demo profile real); Presidio redaction sidecar (redaction profile real); frontend design pass; Forgotten/Settings polish | O1, O2 |
| O4 | Email via per-tenant, receive-only **Haraka** SMTP container (forwarding model — no OAuth/CASA, no sending); inbound parsing into the pipeline as source_type 'email' (incl. calendar-invite parts within emails); thread-aware extraction; deletion saga covers email + receipts; reply drafts through approval, surfaced for the user to send from their own client; inbound address shown in UI with setup guidance; email golden cases (en/hr) | O1 |
| O5 | Time-travel diff UI (per-entity/per-project timeline of how knowledge changed, each change source-linked; point-in-time + change views) + Memory Passport (one-click export of facts, statuses, provenance, validity history, receipts in a documented, versioned open format; export only) | O2, F3 |
| O6 | Operator script + runbook: one script for a fresh OVHcloud Ubuntu instance (install / configure / upgrade / status), auto-does what it can then prints a structured operator TODO (DNS incl. MX for Haraka, OVH backup settings, verification list). Companion runbook: onboarding, manual trial tracking, OVH backup + rehearsed restore, upgrades. **No Terraform, no API automation, no self-serve, no monitoring stack, no backup scripts** | O4 |
| O7 | Launch gate: trust-score public page + compliance one-pager (both **website deliverables** built from curated cross-instance data, not running-instance features); OSS launch prep (CONTRIBUTING/CLA, SECURITY, README, launch checklist); re-run BOTH the gap audit and the security audit. Passing = v1 launchable | all |

## Standing rules
- Golden-set growth is a per-session quota (ladder above); every capability ships with its eval cases.
- Fable handoff specs are frozen interfaces: Opus sessions implement them, deviations need owner sign-off.
- Both audits (gap + security, docs/audits/) are re-run before launch at O7.
- **v1 scope is locked** (per the Roadmap Revision): everything already built, plus email via Haraka (O4), time-travel diff UI + Memory Passport (O5), the operator script + runbook (O6), and the O7 launch-gate deliverables. **Deferred to 2.0+:** calendar connector, local embeddings and a local-LLM tier, operational automation (Terraform/self-serve/monitoring/backup scripts), Memory Passport import, and the dreaming digest chat card.

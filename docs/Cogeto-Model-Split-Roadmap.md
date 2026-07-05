# Cogeto — Model-Split Roadmap (Fable 5 now, Opus 4.8 later)

**Status: BINDING for session planning.** Place at `docs/Cogeto-Model-Split-Roadmap.md`. Supersedes the session numbering S4/S4.5+ in earlier plans; the gap-audit findings (docs/audits/implementation-gap-audit.md) are folded in. Principle: Fable 5 does everything where subtle correctness or model calibration lives; Opus 4.8 executes precisely specified work. Every Fable session ends with a frozen handoff spec in `docs/handoff/` that the corresponding Opus session implements against without redesigning.

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
| O4 | Calendar connector (Graph + Google OAuth, worker sync, meeting prep) + calendar golden cases (~42en/28hr) | O1 |
| O5 | Email connector (Graph + IMAP, thread-aware, drafts through approval) + email golden cases (target checkpoint 50en/35hr) | O4 |
| O6 | Productization (provisioning, trials, backups + restore rehearsal, monitoring, fleet upgrades); trust-score public page; compliance one-pager; re-run the gap audit as the launch check | all |

## Standing rules
- Golden-set growth is a per-session quota (ladder above); every capability ships with its eval cases.
- Fable handoff specs are frozen interfaces: Opus sessions implement them, deviations need owner sign-off.
- The gap audit (docs/audits/) is re-run before launch at O6.
- v1.x after O6 unchanged: time-travel diff UI, Memory Passport, dreaming digest card, local embeddings, OSS launch prep.

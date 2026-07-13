# Session — Doc sync to the v1 Roadmap Revision

**Type:** documentation-sync only. No application code, migrations, schema, tests,
prompts, or eval data were written, modified, or run. No git commands.

**Binding source of truth:** [`docs/Cogeto-v1-Roadmap-Revision.md`](../Cogeto-v1-Roadmap-Revision.md)
(locked decisions D1–D5). This session propagated those decisions into the affected
planning and reference docs, following the revision's "How to apply this document"
section and extending it wherever other docs contradicted the locked decisions.

## Locked decisions propagated

- **D1** Calendar dropped from v1 and not on the v1.x list (post-2.0 only, on real demand).
- **D2** Email via a per-tenant, receive-only **Haraka** SMTP container (forwarding model;
  no OAuth/CASA; sending out of scope; per-tenant addressing, no central inbound domain).
- **D3** Operations are script-driven and manual-by-design (one operator script +
  printed TODO checklist; no Terraform/API automation/self-serve/auto-updates).
- **D4** No trials automation, no monitoring stack, no backup scripts in v1
  (trials tracked manually; backups via OVHcloud panel; monitoring deferred).
- **D5** v1 feature set locked; remaining sessions are **O4–O7**; local embeddings and
  the other items deferred to 2.0+. Trust-score page + compliance one-pager are
  **website deliverables** (curated cross-instance data), not running-instance features.
  ISO 27001 / SOC 2 handled by an external company, kept out of the product roadmap.

## Files changed

| File | One-line reason |
|---|---|
| `docs/Cogeto-Model-Split-Roadmap.md` | Added a "superseded" banner; replaced Opus rows **O4/O5/O6** with the revision's **O4–O7** (email-via-Haraka, time-travel+Passport, operator script+runbook, launch gate); replaced the old v1.x standing rule with the locked v1 scope + 2.0 deferrals; audits re-run moved from O6→O7. F1–F3 and O1–O3 rows left intact. |
| `docs/Cogeto-Technical-Architecture.md` | §8 Implementation Plan: added a "superseded" banner; rewrote the connector-order sentence (notes → email, calendar dropped); replaced phases 5–8 (Calendar/Email-connector/Productization/v1.x) with Email-via-Haraka / Time-travel+Passport / Operator-script / Launch-gate + a "Later (2.0+)" row; added ISO/SOC-2-are-external note; updated the `connectors` container row (line 80) to notes + receive-only Haraka email, no OAuth. |
| `docs/Cogeto-v1-scope.md` | §4.6 Integrations changed from "three (Email/Calendar/Notes)" to "two (Notes/Email)"; email described as receive-only Haraka forwarding; calendar explicitly dropped with a pointer to the revision. |
| `docs/glossary.md` | "Connector" definition changed from "exactly three in v1: notes, calendar, email" to "two in v1: notes and email" (email = Haraka forwarding, no OAuth); calendar dropped. |
| `project/src/connectors/README.md` | Bounded-context README changed from three connectors to two (notes + email via receive-only Haraka); removed the Gmail/CASA and calendar wording; pointer to the revision. |
| `README.md` (repo root) | "O4 (calendar connector) is next" → O4 is email via a per-tenant receive-only Haraka forwarding server; noted calendar dropped from v1. |
| `docs/README.md` | Added the Roadmap Revision to the doc list and **scoped the "Addendum wins over every doc" precedence** so the Revision supersedes the Addendum on the remaining-plan items (O4–O7, connector set, v1 scope) — closes the authority conflict that would otherwise let a future session re-introduce calendar from §A.11. |
| `CLAUDE.md` | Added a Roadmap-Revision row to the doc-map table and scoped the Addendum "wins over every other doc" line the same way — so any future session reading the doc map is pointed at the Revision before O4–O7 work. |
| `docs/Cogeto-v1-Addendum-Verifiable-Memory.md` (owner-approved) | §A.11 gained a superseded banner + rewritten prose (notes → email via receive-only Haraka, no OAuth/CASA/Gmail; calendar dropped); the §A roadmap-mini-table connector-order row updated the same way. Only content change to the top-authority doc, made with owner sign-off. |
| `docs/Cogeto-Roadmap-Revision-Email-Calendar.md` (new) | Created the previously-missing source file the Revision references; marked SUPERSEDED/folded-into the Revision, which it names as the winner; resolves the dangling cross-reference. |

## Deliberately left unchanged (with reason)

- **`CLAUDE.md` line 4** and **`README.md` line 13** — enumerate email/calendar/notes/documents
  as *where the user's scattered context lives* (problem domain), not as a connector list.
  This remains accurate under the revision (meeting invites arrive as email), so no edit was
  made. Neither file contains a session ladder or a "notes/calendar/email connector" list.
- **`AGENTS.md`** — uses `connectors` only as a bounded-context module name (which persists);
  no calendar-as-v1-connector claim, no session plan, no OAuth-email claim. No edit needed.
- **`docs/research/temporal-knowledge-patterns.md`** — the "Email/calendar items have natural
  reference times" line is a descriptive extraction pattern, not a v1-connector claim; also a
  protected research doc. Left as-is.
- **Session logs, decision records, prompt history, eval corpus** — historical record; not altered.

## Owner follow-up — RESOLVED in a second pass (owner approved)

The two items originally flagged below were approved by the owner and are now done:

1. **Missing referenced doc — RESOLVED.** `docs/Cogeto-Roadmap-Revision-Email-Calendar.md` was
   created as the earlier email/calendar working note, explicitly marked **SUPERSEDED / folded into
   `Cogeto-v1-Roadmap-Revision.md`**, which it names as the winner on any conflict ("only the latest
   revision governs"). The dangling reference from the Revision now resolves; the file is also listed
   (as superseded) in `docs/README.md`.

2. **Addendum §A.11 conflict — RESOLVED.** With owner approval, `docs/Cogeto-v1-Addendum-Verifiable-Memory.md`
   §A.11 now carries a superseded banner pointing to the Roadmap Revision, its prose was rewritten to
   *notes → email (receive-only Haraka forwarding, no OAuth/CASA/Gmail)* with calendar dropped, and the
   §A roadmap-mini-table row was updated the same way. The doc-map precedence lines in `docs/README.md`
   and `CLAUDE.md` already scope the "Addendum wins" rule so the Revision wins on the remaining plan.

## Contradictions / items still flagged for owner review

3. **`docs/eval-golden-set.md` line 12** lists corpus item-type proportions including
   "calendar events (~15%)". This is eval reference/methodology (protected), so I did **not** edit
   it. It is arguably still valid since calendar-invite content now arrives *within* emails, but the
   15% calendar-event allocation may want reweighting toward notes/email. **Flagged, not changed.**

4. **`docs/decisions/0003-pre-code-rulings.md` line 46** ("OAuth redirect/callback endpoints and
   webhook receivers live in the **app** process") — written assuming OAuth-based connectors. Under
   D2 the *connector* launch path has no OAuth (Haraka forwarding). This is not a hard conflict —
   Zitadel SSO **login** still uses OAuth, so the endpoints remain relevant — but the connector
   rationale is now moot. Decision records are historical, so left unedited; **flagged** for
   awareness only.

## Summary

- **Files edited:** 9 — `docs/Cogeto-Model-Split-Roadmap.md`, `docs/Cogeto-Technical-Architecture.md`,
  `docs/Cogeto-v1-scope.md`, `docs/glossary.md`, `project/src/connectors/README.md`, `README.md`,
  `docs/README.md`, `CLAUDE.md`, and (owner-approved) `docs/Cogeto-v1-Addendum-Verifiable-Memory.md`.
- **Files created:** 1 — `docs/Cogeto-Roadmap-Revision-Email-Calendar.md` (superseded source note).
  (Plus the assistant's own project-progress memory, outside the repo, updated so the next session's
  "NEXT = O4" pointer reflects email-via-Haraka, not calendar.)
- **Contradictions resolved this session (owner-approved):** 2 — the missing
  `Cogeto-Roadmap-Revision-Email-Calendar.md` (created, marked superseded) and the Addendum §A.11
  calendar/Gmail-CASA conflict (banner + rewrite, with the doc-map precedence scoped so the Revision wins).
- **Contradictions still flagged (deliberately not edited — protected material):** 2 — eval corpus
  calendar-event proportion (`eval-golden-set.md`, eval data); decision 0003 OAuth-endpoint rationale
  (historical decision record; SSO login still uses OAuth, so not a hard conflict).
- **No code, schema, migrations, or tests were touched. No git commands run.** Only Markdown
  planning/reference docs were edited.

# docs — authoritative product documentation

The spec is the source of truth; when code and spec disagree, the spec wins (or is
updated deliberately). Precedence: **the Addendum wins over the scope doc and the
Specification wherever they conflict** (it is newer and resolves their open points) —
**except for the remaining v1 plan (O4–O7 sessions, connector set, and v1 scope lock),
where `Cogeto-v1-Roadmap-Revision.md` supersedes the Addendum** (notably §A.11's
connector order and the Gmail/CASA path).

## Start here

| Doc | What it answers |
| --- | --- |
| [`running-locally.md`](running-locally.md) | Run the stack on your machine: one command, where things are, common issues. |
| [`deployment.md`](deployment.md) | The production model: pull-only signed images, the operator script, cosign verification. |
| [`operator-runbook.md`](operator-runbook.md) | **Operator-facing**: the full lifecycle of a customer instance — provision, install, verify, onboard, backups + rehearsed restore, upgrades, troubleshooting. |
| [`release-process.md`](release-process.md) | How releases are cut and what each one publishes (images, signatures, SBOM). |

## Product and architecture

- [`Cogeto-v1-Roadmap-Revision.md`](Cogeto-v1-Roadmap-Revision.md) — **BINDING** for the remaining v1 plan: O4–O7
  sessions, email via a per-tenant receive-only forwarding server, calendar
  dropped from v1, operations script-driven, v1 scope locked. Wins over earlier plans.
- [`Cogeto-Roadmap-Revision-Email-Calendar.md`](Cogeto-Roadmap-Revision-Email-Calendar.md) — **superseded**; the earlier email/calendar
  working note, now folded into the Roadmap Revision above (kept for provenance only —
  plan against the Revision, which wins).
- [`Cogeto-v1-Addendum-Verifiable-Memory.md`](Cogeto-v1-Addendum-Verifiable-Memory.md) — **binding** architecture decisions
  (Part A) + the Verifiable Memory feature set with sequencing tags (Part B).
- [`Cogeto-v1-scope.md`](Cogeto-v1-scope.md) — the locked v1 scope and strategy.
- `Cogeto-v1-Specification.docx` — the full v1 product specification (binary; maintainer-managed).
- [`Cogeto-Technical-Architecture.md`](Cogeto-Technical-Architecture.md) — full engineering plan: stack rationale,
  containers, mechanisms, phased implementation (the `.docx` is the presentation copy).
- [`glossary.md`](glossary.md) — the ubiquitous language; names in code must match it.

## Engineering

- [`engineering-workflow.md`](engineering-workflow.md) — the delivery loop: issues, branches,
  Conventional-Commit PRs, the five required checks, squash-merge, tag-driven
  releases. (The outsider's version is the repo-root [`CONTRIBUTING.md`](../CONTRIBUTING.md).)
- [`decisions/`](decisions/) — short numbered decision records; 0001 (repo structure) and
  0002 (technology stack) are binding, and every notable decision since is here.
- [`eval-golden-set.md`](eval-golden-set.md) — corpus format, metrics, and CI gates for the eval
  harness; [`eval/history.md`](eval/history.md) records every measured run.
- [`research/`](research/) — anonymized engineering patterns distilled from studied production
  systems; required reading before implementing memory/agents/retrieval/pipeline code.
- [`design/`](design/) — the SPA's design system: palette, status vocabulary, component kit,
  accessibility rules.

## Schemas and formats

- [`passport-schema/`](passport-schema/) — the **Memory Passport** open export format: JSON
  Schemas, a sample archive, and the independent-verification steps.
- [`trust-scores-schema/`](trust-scores-schema/) — the **published per-release quality
  record** the trust-score page renders (schema + example; data in
  `eval/trust-scores/`, one immutable JSON per release).

## Operations

- [`operations/adding-users.md`](operations/adding-users.md) — creating users on an instance (and the no-outbound-SMTP trap).
- [`operations/image-pins.md`](operations/image-pins.md) — how base/infra images are digest-pinned and updated.
- [`notes/`](notes/) — developer-facing notes per feature area (email inbound/source,
  the Memory Passport, the time-travel UI, the operator script, CI/CD setup).

## Transparency

- [`audits/`](audits/) — the implementation-gap audit and the quality/security audit,
  **published with every finding and its resolution** — deliberately.
- [`eval/history.md`](eval/history.md) — the measured quality record over time.

## History

- [`sessions/`](sessions/) — per-session engineering logs (what was built, decided, and verified).
- [`handoff/`](handoff/) — frozen inter-session contracts (deletion saga, dreaming, tasks).

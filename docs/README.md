# Documentation

Start with whichever row matches what you are doing.

**Authority.** [`cogeto-specification.md`](cogeto-specification.md) is the normative
rulebook and wins on any question of what the system must do.
[`cogeto-v2-plan.md`](cogeto-v2-plan.md) is binding for what gets built now.

## The core documents

| Doc | What it answers |
| --- | --- |
| [`cogeto-scope.md`](cogeto-scope.md) | What Cogeto is, who it is for, what is in and out of scope, and how it is licensed. Read this first. |
| [`cogeto-specification.md`](cogeto-specification.md) | **The normative rules.** MUST is a rule whose violation is a defect; SHOULD is a tradeoff that needs a recorded reason. Carries the numeric parameters in force. |
| [`cogeto-technical-architecture.md`](cogeto-technical-architecture.md) | How it is built: deployment, module structure, the ingestion pipeline, retrieval, access gates, the model gateway, trust machinery. |
| [`cogeto-verified-memory.md`](cogeto-verified-memory.md) | What is stored, what is guaranteed about it, and how each guarantee is enforced. Written to be checked rather than believed. |
| [`cogeto-v2-plan.md`](cogeto-v2-plan.md) | The plan of record for the 2.0 cycle, version by version, with priority and difficulty. |
| [`cogeto-v2-architecture.pdf`](cogeto-v2-architecture.pdf) | The 2.0 architecture diagram. |

## Run it

| Doc | What it answers |
| --- | --- |
| [`running-locally.md`](running-locally.md) | Run the stack on your machine: one command, where things are, common issues. |
| [`deployment.md`](deployment.md) | The production model: pull-only signed images, the operator script, cosign verification. |
| [`operator-runbook.md`](operator-runbook.md) | The full lifecycle of a customer instance: provision, install, verify, onboard, back up, restore, upgrade, troubleshoot. |
| [`operations/`](operations/) | Adding users, image pins, inbound email setup, the operator script, CI/CD. |
| [`release-process.md`](release-process.md) | How releases are cut and what each publishes. |

## How each feature behaves

The specification says what must be true. These say how the shipped system does it,
and why it was built that way.

| Doc | Covers |
| --- | --- |
| [`memory.md`](features/memory.md) | The lifecycle, the gates, reconciliation, the nightly pass, open loops, time travel. **Read this first.** |
| [`conversation.md`](features/conversation.md) | Chat routing, per-claim provenance, instance context, language, conversations. |
| [`sources.md`](features/sources.md) | Notes, files, email, web, chat capture, and the ports a source implements. |
| [`web-research.md`](features/web-research.md) | Discovery, the fetcher, minimisation, the run record, focused extraction. |
| [`named-skills.md`](features/named-skills.md) | The skill runtime, the plan gate, the brief. |
| [`models.md`](features/models.md) | Tiers, provider adapters, local inference, determinism, redaction. |
| [`approvals.md`](features/approvals.md) | The gate consequential actions pass through. |
| [`memory-passport.md`](features/memory-passport.md) | The open, verifiable export format. |
| [`attention.md`](features/attention.md) | The dashboard feed and its honesty rules. |
| [`capabilities.md`](features/capabilities.md) | Optional services: observable, controllable, announced. |
| [`demo-sandbox.md`](features/demo-sandbox.md) | The Ana sandbox and its deployment invariants. |

## Build it

| Doc | What it answers |
| --- | --- |
| [`engineering-workflow.md`](engineering-workflow.md) | The delivery loop: issues, branches, Conventional-Commit PRs, the five required checks, squash-merge. The outsider's version is [`CONTRIBUTING.md`](../CONTRIBUTING.md). |
| [`glossary.md`](glossary.md) | The ubiquitous language. Names in code must match it. |
| [`eval-golden-set.md`](eval-golden-set.md) | Corpus format, labeling rules, metrics, CI gates, cached evals on pull requests. |
| [`eval/history.md`](eval/history.md) | The measured quality record. |
| [`eval/gate-model.md`](eval/gate-model.md) | Why every gate sits where it sits: the floor, the specification target, the gap, and the work that closes it. |
| [`eval/v1-1-0-precision-drop.md`](eval/v1-1-0-precision-drop.md) | The one time a metric fell more than two points and no record was written. Written late. |
| [`eval/website-follow-up.md`](eval/website-follow-up.md) | Follow-ups from the trust-honesty work: the retrieval tiebreak that would let the chat suite join the cached gate, and exactly what the website must add to render the new metrics. |
| [`research/`](research/) | Anonymized engineering patterns from studied production systems. **Required reading** before implementing memory, ingestion, retrieval, agents, or pipeline code. |
| [`design/`](design/) | The SPA's design system: palette, status vocabulary, component kit, accessibility. |

## Contracts and transparency

| Doc | What it answers |
| --- | --- |
| [`passport-schema/`](passport-schema/) | The Memory Passport export format: JSON Schemas, a sample archive, verification steps. Versioned by directory; old versions stay published. |
| [`trust-scores-schema/`](trust-scores-schema/) | The published per-release quality record (schema plus example; data in `eval/trust-scores/`). |
| [`security/`](security/README.md) | **Single entry point** for how the protections work, how to verify them, and the tests that enforce them. Reporting policy is the repo-root [`SECURITY.md`](../SECURITY.md). |
| [`dockerhub/`](dockerhub/) | The published image overviews. |

**The decision trail is the issue and the pull request.** What changed and why lives
in the pull request that changed it, and the documentation above is kept current in
the same change.

# Documentation

Start with whichever row matches what you are doing. The architecture authority is
[`Cogeto-v1-Addendum-Verifiable-Memory.md`](Cogeto-v1-Addendum-Verifiable-Memory.md);
it wins over every other document on an architecture question.
[`Cogeto-V2-Plan.md`](Cogeto-V2-Plan.md) is binding for what gets built now.

## Run it

| Doc | What it answers |
| --- | --- |
| [`running-locally.md`](running-locally.md) | Run the stack on your machine: one command, where things are, common issues. |
| [`deployment.md`](deployment.md) | The production model: pull-only signed images, the operator script, cosign verification. |
| [`operator-runbook.md`](operator-runbook.md) | The full lifecycle of a customer instance: provision, install, verify, onboard, back up, restore, upgrade, troubleshoot. |
| [`operations/`](operations/) | Adding users, image pins, inbound email setup, the operator script, CI/CD. |
| [`release-process.md`](release-process.md) | How releases are cut and what each publishes. |

## Understand it

| Doc | What it answers |
| --- | --- |
| [`architecture.md`](architecture.md) | Stack, processes, module map, pipeline, seams, storage split. |
| [`features/`](features/) | How each feature behaves and why it behaves that way. |
| [`glossary.md`](glossary.md) | The ubiquitous language. Names in code must match it. |
| [`Cogeto-v1-scope.md`](Cogeto-v1-scope.md) | Scope, users, positioning, business model. |
| `Cogeto-v1-Specification.docx` | The full product specification (binary; owner-maintained). |

### Features

| Doc | Covers |
| --- | --- |
| [`memory.md`](features/memory.md) | The lifecycle, the gates, reconciliation, dreaming, open loops, time travel. **Read this first.** |
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
| [`eval-golden-set.md`](eval-golden-set.md) | Corpus format, labeling rules, metrics, CI gates. |
| [`eval/history.md`](eval/history.md) | The measured quality record. |
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

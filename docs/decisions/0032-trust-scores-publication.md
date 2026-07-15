# 0032 — Trust scores: published format and the pipeline-commit mechanism

**Status:** Accepted. **Context:** O7 launch gate — the public trust-score
page renders per-release quality data. This record freezes the data contract
and, mainly, HOW an automated pipeline lands files on a protected `main`.

## Ruling 1 — One immutable JSON per release, schema-stable like the Passport

`eval/trust-scores/vX.Y.Z.json`, validating against the published schema
(`docs/trust-scores-schema/`, version 1.0): `generated_by` (tag, commit,
harness identity, timestamp, `backfilled`), `configurations[]` (stable id,
exact models, redaction flag, per-language corpus sizes, per-language +
aggregate metrics, chat pass summary with failing case ids published), and
optional `notes[]` — the honesty line: dips ship with explanations.
**Release files are immutable**: the publisher refuses to overwrite an
existing version; corrections are notes in the *next* release. `index.json`
is always **rebuilt from the directory**, so it cannot reference a missing
file. Schema changes follow Passport discipline (additive → minor, breaking
→ major; the Zod mirror in `project/src/entrypoints/trust-scores.ts` is the
enforced twin of the published JSON Schema).

## Ruling 2 — Emission is part of the harness, not a scraper

`npm run eval -- --emit-json <path>` and `npm run eval:chat -- --emit-json
<path>` write/merge one **configuration partial** (validated on every write);
`scripts/ci/publish-trust-scores.mjs` combines one or more configuration
partials into the release file. Numbers are emitted from the same in-memory
results the gates check — never re-parsed from logs or history tables.
Emission happens BEFORE the gate verdict so breaches still record honest
numbers (the release only publishes after gates pass).

## Ruling 3 — Pipeline commits to protected main go through an auto-merged PR

Chosen over a bypass rule for the release workflow, because it is the only
option that is simultaneously auditable and safe:

- The publish lands as a **real pull request** (`chore: publish trust scores
  for vX.Y.Z`) that must pass the same five required checks as any change —
  no branch-protection exception exists for any actor, so nothing can
  impersonate the pipeline to sneak content onto `main`.
- The trust-score spec validates every file in `eval/trust-scores/` as part
  of `test`, so a malformed emission cannot merge even automatically.
- Auto-merge (`gh pr merge --auto --squash`) completes the loop without a
  human, but the PR, its checks, and its diff remain in the record forever.

Mechanics: the step authenticates with the owner PAT when available
(`PROJECTS_TOKEN`) — PRs opened by `github.token` do not trigger workflows
(GitHub's recursion guard), which would leave required checks pending and
auto-merge stuck; the PAT-opened PR runs them normally. Fallback to
`github.token` still creates the PR for a manual merge.

## Ruling 4 — The step never blocks the release

The trust-score step runs **after** images are pushed, signed, and the
GitHub Release exists, with `continue-on-error: true` and a loud
`::error` notice on failure with the exact manual-retry commands. A release
without trust scores is a gap to fix; a release blocked by a metrics-plumbing
failure would be worse.

## Ruling 5 — Backfill is marked, absence is explained

Already-published releases get files only where measured data exists —
transcribed numbers carry `backfilled: true` and name their source in
`notes[]` (v0.8.0 from `docs/eval/history.md`; v0.9.1 from the live gate run
log). v0.9.0 has **no** file: it shipped before the repository had a model
API key, so no measured run exists — stated in v0.9.1's notes rather than
invented.

## Ruling 6 — The redacted configuration is maintainer-run

The release job measures the **default** configuration only; the Presidio
sidecar (~1 GB model image) is not cheaply runnable there. The redacted
configuration is added by running both suites locally with the sidecar up and
passing a second `--partial` to the publisher (documented in
`docs/trust-scores-schema/README.md`). The two-configuration file shape is
first-class in the schema from day one.

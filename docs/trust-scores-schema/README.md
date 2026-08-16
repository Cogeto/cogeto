# Trust scores: the published per-release quality record

Cogeto measures itself before it ships (spec §14) and **publishes the numbers**:
one JSON file per release under [`eval/trust-scores/`](../../eval/trust-scores/),
rendered by the public trust-score page on cogeto.eu. This directory is the
open contract for that data, treated with the same schema-stability care as
the [Memory Passport](../passport-schema/): additive changes bump the minor
version, breaking changes the major, and every emitted file validates against
the schema before it is written.

| File | Purpose |
| --- | --- |
| [`trust-scores.schema.json`](trust-scores.schema.json) | JSON Schema (draft 2020-12) for one release file. |
| [`example.json`](example.json) | A complete, schema-valid example. |

## Shape, in words

- **`generated_by`**: the release tag, the exact commit, the harness identity
 (prompt + threshold versions), the timestamp, and `backfilled` (true when
 numbers were transcribed from recorded runs rather than emitted at release
 time: the backfilled early releases say so).
- **`configurations[]`**: one entry per **measured model configuration**
 (e.g. `mistral-default`, `mistral-default-redacted`): the exact pipeline,
 answer, and embedding models, the redaction flag, corpus sizes per language,
 and the metrics, per language and aggregate, for extraction precision and
 recall, verification agreement, dedup accuracy, contradiction **precision**
 and recall, **supersedes accuracy** with its denominator, and **query-rewrite
 routing accuracy**, plus the chat-suite pass summary (failing case ids are
 published, not hidden).
- **`notes[]`**: one-line human explanations for notable changes. This is the
 honesty line: a dip ships with an explanation, never silently.

`index.json` (in `eval/trust-scores/`) lists every published release:
`[{version, date, path}]`, newest first, and is rebuilt from the directory on
every publish, so it can never reference a missing file.

A version is `vX.Y.Z`, optionally followed by a lowercase `-suffix`
(`v1.4.2-local`). The suffix marks a measurement published beside the releases
without being one: a maintainer-run configuration on a given release's code,
named so it can never be mistaken for the release artifact. Release tags stay
plain semver, and ordering treats a suffixed version as older than the plain
release of the same number.

## How the data is produced

```sh
# One measured configuration (whatever the env configures) → a partial file:
npm run eval -- --emit-json /tmp/trust-partial.json # golden set + reconciliation
npm run eval:chat -- --emit-json /tmp/trust-partial.json # merges the chat summary in

# The release publisher combines partials into the immutable release file:
node scripts/ci/publish-trust-scores.mjs \
 --version vX.Y.Z --sha <commit> --partial /tmp/trust-partial.json
```

The release pipeline does this automatically for the **default configuration**
after the gates pass (see [`docs/release-process.md`](../release-process.md)). The **redacted configuration** is added by the maintainer
when measured: run both suites with the redaction sidecar up
(`REDACTION_ENABLED=1`, profile `redaction`) emitting to a second partial, and
pass both `--partial` files to the publisher. **Alternate provider
configurations** (bring-your-own-key: e.g. `openai-default`,
`anthropic-answer`, or a custom `pipe-…--ans-…--emb-…` id) follow the same
owner-run flow: configure the providers in the environment, emit to their own
partial file, and pass it as an additional `--partial`
(see [`docs/features/models.md`](../features/models.md); provider
keys are never CI secrets).

## Why the latest published file can lag the latest release

**It does today, and this section is here so the gap is explained rather than
merely visible.** The newest artifact in [`eval/trust-scores/`](../../eval/trust-scores/)
is **v1.7.1**; the shipping release is **v1.7.3**.

The reason is the publication flow, not a hidden number. Publishing is an
**owner-run step after a release**: the live post-merge gate on `main` is what
produces the partials, and a human then runs the publisher and opens a pull
request with the result (the last one was "chore: publish trust scores for
v1.7.1"). Nothing publishes itself, deliberately, because the artifact is a
claim and a claim gets a person's name on it. A release can therefore ship
before its measurement does, and v1.7.2 and v1.7.3 are in exactly that state.

**What that does and does not mean for a reader:**

- The artifact is keyed by **configuration id**, not by release. It answers
  "what does this model configuration score on this corpus", and the Models
  page looks it up by that id.
- Between v1.7.1 and v1.7.3 the **prompts, the corpus and the gate floors did
  not change** (`git diff v1.7.1 v1.7.3 -- project/prompts project/eval` is
  empty), so no measured behaviour moved and the v1.7.1 numbers remain the
  honest figure for that configuration. The releases in between changed the
  interface, the operator tooling, translations and container hardening.
- It is still a lag and not a nothing: a release that DID change a prompt or
  the pipeline must not ship without its measurement, and the fix is to run
  the publish step, never to reason that the numbers probably held.

**A missing measurement is never approximated.** No file is written from an
older run's numbers, no release inherits its predecessor's score, and the
Models page says **"not evaluated"** for a configuration with no artifact
rather than showing the nearest one. Publishing a number that was not measured
for the thing it is attached to would be the one failure this whole artifact
exists to prevent.

## Versions

| Version | Change |
| --- | --- |
| **1.1** | Additive (V2.0 item 3.4). Added `contradiction_precision`, `supersedes_accuracy`, `supersedes_pairs` and `rewrite_accuracy` per language and aggregate, plus `rewrite_cases` and per-language `reconcile_pairs` on the corpus. Contradiction precision had been **measured** since the reconciliation suite existed and was simply never emitted, which made the published picture the flattering half of what the harness knew. |
| 1.0 | Initial published format. |

Every published `1.0` file stays valid and stays published: release files are
immutable, and the reader accepts the whole `1.x` line. New fields are optional
in the schema for exactly that reason.

## Rules

- **Release files are immutable.** The publisher refuses to overwrite an
 existing `vX.Y.Z.json`; wrong numbers are explained in the next release's
 `notes`, never rewritten.
- Fractions are `0..1` (the website formats percentages).
- Configuration `id`s are stable across releases: they are the join key for
 trend lines.
- **Only live runs are published.** The eval harnesses refuse `--emit-json`
 when replaying the cached fixtures used by the pull-request gate
 (`docs/eval-golden-set.md` §6), so a cached run can never become a trust
 score.
- **A rate is published with its denominator** where the denominator is small.
 `supersedes_accuracy` ships beside `supersedes_pairs` because a score over one
 case means nothing, whether it passes or fails.

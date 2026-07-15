# Trust scores — the published per-release quality record

Cogeto measures itself before it ships (§B.4) and **publishes the numbers**:
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

- **`generated_by`** — the release tag, the exact commit, the harness identity
  (prompt + threshold versions), the timestamp, and `backfilled` (true when
  numbers were transcribed from recorded runs rather than emitted at release
  time — the backfilled early releases say so).
- **`configurations[]`** — one entry per **measured model configuration**
  (e.g. `mistral-default`, `mistral-default-redacted`): the exact pipeline,
  answer, and embedding models, the redaction flag, corpus sizes per language,
  and the metrics — per language and aggregate — for extraction precision and
  recall, verification agreement, dedup accuracy, and contradiction recall,
  plus the chat-suite pass summary (failing case ids are published, not
  hidden).
- **`notes[]`** — one-line human explanations for notable changes. This is the
  honesty line: a dip ships with an explanation, never silently.

`index.json` (in `eval/trust-scores/`) lists every published release —
`[{version, date, path}]`, newest first — and is rebuilt from the directory on
every publish, so it can never reference a missing file.

## How the data is produced

```sh
# One measured configuration (whatever the env configures) → a partial file:
npm run eval -- --emit-json /tmp/trust-partial.json         # golden set + reconciliation
npm run eval:chat -- --emit-json /tmp/trust-partial.json    # merges the chat summary in

# The release publisher combines partials into the immutable release file:
node scripts/ci/publish-trust-scores.mjs \
  --version vX.Y.Z --sha <commit> --partial /tmp/trust-partial.json
```

The release pipeline does this automatically for the **default configuration**
after the gates pass (see [`docs/release-process.md`](../release-process.md)
and decision 0032). The **redacted configuration** is added by the maintainer
when measured: run both suites with the redaction sidecar up
(`REDACTION_ENABLED=1`, profile `redaction`) emitting to a second partial, and
pass both `--partial` files to the publisher.

## Rules

- **Release files are immutable.** The publisher refuses to overwrite an
  existing `vX.Y.Z.json`; wrong numbers are explained in the next release's
  `notes`, never rewritten.
- Fractions are `0..1` (the website formats percentages).
- Configuration `id`s are stable across releases — they are the join key for
  trend lines.

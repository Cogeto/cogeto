# 0007 — Quality-hardening rulings (Session 3.5)

**Date:** 2026-07-03 · **Status:** accepted · **Governs:** relative-date
resolution, the citation marker grammar, per-task model tiers, and conversational
query rewriting. **Driven by:** the owner test report (~30 real notes about a
consultant persona; failures F1–F8), recorded in `docs/sessions/S3.5-A.md`.

> **Numbering note.** The S3.5-A prompt calls this "decision record 0005", but
> records 0005 (S2-B) and 0006 (S3-A) already exist and are immutable, so this is
> **0007** — the same offset noted in S3-A. References below to "the S3-A
> fast-path heuristic" mean the query-entity heuristic documented in
> `docs/sessions/S3-A.md`, which the prompt calls "decision 0004".

## Ruling 1 — Relative dates are resolved by deterministic code, not the model

The extractor emits raw temporal expressions verbatim (`temporal_expressions:
[{ raw, kind }]`); a deterministic resolver (`temporal-resolver.ts`, chrono-node
plus a custom F8 pass) resolves each against the note's `created_at`. Weekday
names resolve to the next occurrence strictly after the anchor; "by X" is a
`valid_until`; "in N days/weeks" adds to the anchor; unresolvable expressions
leave the field null and are recorded in `memory.temporal_unresolved` (migration
0007) for the drawer to flag. This supersedes the S2 extraction-contract detail
where the model computed dates. The resolver accepts BOTH contracts (new
expressions and v0001's pre-resolved ISO fields) so nothing breaks before the
v0002 extraction prompt ships in S3.5-B.

*Rationale:* F8 — models do calendar arithmetic unreliably ("by Monday" → the
wrong day); code does it exactly and testably, and the same anchor gives the
same date forever.

## Ruling 2 — One citation marker grammar; the renderer strips everything else

The single canonical, stored, renderer-trusted citation form is
`{{cite:<memory-uuid>}}`. The answer model emits short `[F1]` markers; the
backend post-processor canonicalizes them to `{{cite:uuid}}` and strips every
other bracketed or braced token, counting each as a `citation_violation`
(metadata only). The renderer trusts only the canonical form. Grammar and logic
live once in `@cogeto/shared/citations.ts`; documented in
`project/prompts/answer/README.md`.

*Rationale:* F6 — raw markers like `[F2, F4]` leaked to users and citation styles
mixed within one answer; a single grammar enforced at the boundary makes a leak
structurally impossible.

## Ruling 3 — Per-task model tiers (pipeline vs answer)

The gateway maps two tiers to concrete models: `pipeline`
(`MISTRAL_MODEL_PIPELINE`, default `mistral-small-latest`) for extraction,
verification, and future consolidation; `answer` (`MISTRAL_MODEL_ANSWER`,
default `mistral-medium-latest`) for chat synthesis and the eval grader.
Embeddings are unchanged. Task sites request a tier, never a model string.

*Rationale:* F1/F4 — the user-facing synthesis path needs a stronger model than
the high-volume ingestion path; tiering raises answer quality where it is read
without moving the ingestion/embedding cost floor.

## Ruling 4 — Conversational query rewriting joins the fast path

A single bounded model call rewrites the user's turn against recent conversation
before retrieval, so pronouns and follow-ups ("who is she?") resolve to their
referent. This revises the S3-A fast-path decision (query entities via a
heuristic only, no model call): the fast path may now make ONE cheap rewrite
call in addition to the query embedding. Implemented in S3.5-B.

*Rationale:* F3 — retrieval on a bare pronoun finds nothing; carrying
conversational context is what makes multi-turn chat answer "who she is".

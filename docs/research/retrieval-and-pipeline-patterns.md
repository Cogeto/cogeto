# Retrieval and pipeline patterns

Distilled from studying the retrieval and ingestion designs of production memory
systems. Pattern → rationale → application; Cogeto mapping at the end.

## 1. Hybrid retrieval: three signals, fused, then optionally reranked

**Pattern:** Production memory retrieval converges on the same recipe:
1. **Semantic** vector search, deliberately over-fetching (3–4× the requested k).
2. **Keyword/full-text** (BM25-class) over lemmatized/normalized text stored at
   write time.
3. **Entity match** — memories linked to entities recognized in the query get a
   bounded score boost.
Signals are fused — either weighted score combination with normalization at each
source, or reciprocal rank fusion (RRF) over the ranked lists — followed by an
optional cross-encoder rerank of the fused top slice.

**Rationale:** Vector-only retrieval misses exact names, numbers, and rare terms —
precisely the tokens that matter in "what did I promise Marko about the March
invoice." Keyword-only misses paraphrase. Entity boost is the cheap proxy for the
graph traversal Cogeto chose not to build.

**Details that matter in practice:**
- Normalize every backend's score to [0,1] at the adapter boundary, or fusion
  weights silently mean different things per backend (BM25 raw scores need a
  sigmoid/midpoint normalization).
- RRF is rank-based and robust to miscalibrated scores; weighted fusion is more
  tunable but needs the normalization discipline. Start with RRF (Addendum §A.5
  chose it); revisit only with eval evidence.
- Rerankers are pluggable and optional — design the seam, defer the dependency
  (local reranker is tagged v1.x, §A.10).

**Application:** Store a lemmatized copy of fact text at write time (Postgres FTS
column); extract entities at write time so retrieval-time entity match is a lookup
(trigram index), not a model call.

## 2. Filter placement: gates in the store, scoring in the app

**Pattern:** Scope/tenant identifiers are indexed payload fields in the vector store,
applied as filters **inside** the vector query. Every studied system that "filters
later" in application code is one forgotten line away from a cross-user leak; the
systems that never leak are the ones where an unfiltered query is impossible to
express through the internal API.

**Application:** Cogeto's rule (§A.4/§A.5): `scope` and `sensitive` are hard gates —
Qdrant payload pre-filters with payload indexes on `owner_id`, `scope`, `status`;
post-hoc score demotion is forbidden for gates ("a demoted leak is still a leak").
Statuses, by contrast, are *score multipliers applied after the gates* — that split
(gate vs multiplier) is Cogeto's addition; no studied system distinguishes them.
Make the retrieval module's query builder require scope parameters in its type
signature so an unscoped call cannot compile/construct.

## 3. Chunking serves extraction, not storage

**Pattern:** In fact-extracting systems, chunking exists to fit accurate extraction
into a model's attention span — the chunks themselves are discarded after facts are
extracted. Systems that embed and store raw chunks as "memories" accumulate
unreviewable noise (the failure mode Cogeto's spec bans outright). Chunk boundaries
should respect document structure; adjacent-chunk overlap protects facts spanning
boundaries; extraction receives surrounding context (recent items, known entities)
alongside the chunk.

**Application:** Cogeto chunks inside ingestion's extract step only. What persists:
the original file (object storage, §4.10) and extracted facts (Postgres + Qdrant).
Chunks are never rows. Re-processing (better prompts later) re-chunks from the
stored original.

## 4. Extraction-prompt structure that survives production

**Pattern:** The extraction prompts that hold up share a shape:
- A tightly scoped role statement and an explicit output JSON schema (validated,
  with retry-on-schema-violation).
- Positive and negative instruction pairs ("capture X; never capture Y") rather
  than abstract quality adjectives.
- An explicit **reference time** parameter with the rule that all relative time
  expressions resolve against it.
- Context blocks clearly delimited: current content, recent prior items, known
  entities — each labeled, so the model attributes correctly.
- Specificity rules: never generalize proper nouns/amounts; preserve qualifiers.
- Attribution per fact (who asserted it) and a "not extractable" escape hatch.

Separate, smaller prompts for narrow follow-ups (timestamp resolution, attribute
fill-in) beat one mega-prompt — cheaper models handle the narrow calls.

**Application:** These rules are the starting skeleton for Cogeto's extraction and
verification prompt families in `project/prompts/` (versioned, §B.7). The
verification pass (§B.3) must use a *different* prompt shape (claim + source excerpt
→ supported/unsupported/partial), not the extractor's rubric — independence is the
point. Multilingual note: prompts must state the output-language rule explicitly
(facts stored in source language; entity names never translated) — the golden set
covers each served language (§B.4).

## 5. Dedup thresholds and their failure modes

**Pattern:** Semantic dedup uses embedding similarity with a high threshold
(≈0.95 observed in production for "same fact"), hard-coded in most systems — and
wrong for edge cases in all of them: near-identical text with a differing number/date
is a *contradiction* that similarity cannot see. The robust design routes
high-similarity pairs to a cheap arbitration call ("same fact, or materially
different?") instead of auto-merging above threshold.

**Application:** Cogeto's reconciliation: similarity shortlist → arbitration with the
material-difference rule (see `temporal-knowledge-patterns.md` §3) → merge to
`replaced` or flag `contradicted`. Thresholds live in config, not code, and the
golden set includes near-duplicate-with-different-number cases explicitly.

## 6. Evaluation: the harness is part of the extractor

**Pattern:** Working memory-quality evaluation is an **ingest → retrieve → judge**
loop over a hand-labeled corpus: expected facts per source item (extraction
precision/recall), expected retrievals per question (hit rate), and a judge model
scoring end-to-end answers. Two operational lessons: (a) the labeled set grows from
real failure cases, not synthetic bulk; (b) the harness must run per prompt/model
change, or regressions land silently — systems that bolted evaluation on later
could not attribute quality drops to causes.

**Application:** Cogeto builds the golden set (50–100 labeled items per language)
*with* the extractor (§A.11), wires it as a CI gate (§B.4: regressing prompt/model
changes fail the build), and records per-prompt-version scores (§B.7). Metrics:
extraction P/R, dedup accuracy, contradiction-detection P/R, verification agreement.
The published trust-score page is this harness's output, not extra work.

## 7. Pipeline shape: synchronous nothing

**Pattern:** Every studied ingestion pipeline that feels fast does all model work
asynchronously in batches: batch embedding calls with per-item fallback, parallel
independent stages, bulk inserts in one transaction per batch. The request path
never waits on extraction.

**Application:** Already binding for Cogeto (scope §6, §A.1, §A.3): the fast path is
retrieval + answering only; every ingestion stage is a worker job with the
idempotency key; stage boundaries are outbox events. Batch the embedding calls from
day one — embedding is the highest-volume model call in the system (§A.10).

## Application to Cogeto — summary

| Pattern | Cogeto realization |
|---|---|
| Vector + keyword + entity, fused | §A.5: Qdrant + Postgres FTS + trigram, RRF |
| Over-fetch before fusion | 3–4× k from each signal before fusing |
| Score normalization at adapter boundary | [0,1] contract in the vector-store interface |
| Gates in-store, never post-filter | Qdrant payload pre-filters; unscoped queries unrepresentable |
| Gate vs multiplier split | scope/sensitive gate; statuses multiply (§A.5 table) |
| Chunks are transient | facts + originals persist; chunks never stored |
| Schema-validated, reference-timed prompts | versioned prompt families with output schemas (§B.7) |
| Similarity shortlist → arbitration | reconciliation; thresholds in config; golden-set edge cases |
| Ingest→retrieve→judge harness as CI gate | §B.4 golden set, built with the extractor |
| Async everything, batched model calls | worker jobs + outbox; batched embeddings |

One-line takeaway: retrieval quality is a fusion problem, retrieval *safety* is a
filter-placement problem, and extraction quality is a measurement problem — solve
them in the store, in the query builder's types, and in CI respectively.

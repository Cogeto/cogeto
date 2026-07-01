# Memory architecture patterns

Distilled from studying production memory systems for LLM applications. Written as
pattern → rationale → application. Cogeto-specific mapping at the end.

## 1. The memory lifecycle: additive by default, curated deliberately

**Pattern:** Mature memory pipelines have converged on an *additive* write path:
extract candidate facts, deduplicate cheaply, insert — and defer conflict resolution
to a separate mechanism, rather than making every write an LLM-arbitrated
ADD/UPDATE/DELETE decision.

**Rationale:** In-line update/delete decisions by an LLM at write time were tried and
abandoned in production systems: they are slow (extra model calls per write), brittle
(a wrong UPDATE silently destroys a good memory), and unauditable (nothing records why
a fact vanished). Additive writes are fast and safe; the cost is that contradictions
accumulate until something reconciles them.

**Application:** Cogeto keeps the additive fast write path but pairs it with what the
studied systems lack: the reconciliation job (slow path) resolves duplicates and
contradictions *by changing statuses, never by destroying rows*. An additive pipeline
without reconciliation pollutes; reconciliation without additive writes is slow.
Cogeto needs both, and the seven-status model is precisely the mechanism that lets
reconciliation act without deleting.

## 2. Extraction: contextually rich facts, not summaries and not raw text

**Pattern:** Extraction prompts that work in production share rules worth adopting:
- Extract from **both** sides of a conversation (user statements AND assistant
  commitments/recommendations), but never echo-backs or acknowledgments.
- Require **contextual richness**: motivations, transitions ("switched from X to Y
  because Z"), and absolute temporal grounding ("May 15" resolved against a supplied
  reference time, never "last week").
- Require **specificity preservation**: proper nouns, titles, amounts, counts must
  never be generalized.
- Structured output schema with per-fact attribution (who said it) and links to
  related already-known facts.

**Rationale:** The dominant failure mode is not missing facts — it is vague facts
("user has a meeting") that are useless at retrieval time, and relative dates that rot.

**Application:** Cogeto's extraction prompt (a versioned artifact) adopts all four
rules. Attribution maps to provenance (`source_type`/`source_id`, NOT NULL); the
reference-time rule is mandatory because commitments are Cogeto's core query.

## 3. Cheap dedup first, semantic dedup later

**Pattern:** Two-tier deduplication: (1) at write time, an exact content-hash check
against recently retrieved memories and within the current batch — CPU-only, no model
call; (2) asynchronously, semantic near-duplicate detection over embeddings with a
high similarity threshold, merging via a reviewable operation.

**Rationale:** Exact-hash dedup catches the high-volume trivial case for free. Semantic
dedup is expensive and fuzzy — done inline it slows writes and silently merges facts
that differ in a detail that matters ("joined in 2020" vs "joined in 2021" is a
contradiction, not a duplicate).

**Application:** Tier 1 lives in ingestion's store step (hash column on the memory
row). Tier 2 is the reconciliation job; merges close the loser's validity interval and
set `replaced`, pointing at the winner — reviewable in the dashboard, never silent.

## 4. Scoping and metadata: identifiers as first-class filters

**Pattern:** Production memory APIs require at least one scope identifier on every
operation (add, search, list, delete) and validate it at the entry point; scope
identifiers are promoted to top-level payload fields in the vector store so they can
be **pre-filtered inside the store's query**, not post-filtered in app code.

**Rationale:** Optional scoping is how leaks happen; the systems that treat scope as
"just metadata" push filtering into application code, where one forgotten filter
returns another user's memories.

**Application:** Cogeto goes further than any studied system: `owner_id` and `scope`
are NOT NULL columns (Addendum §A.6), Qdrant carries payload copies with payload
indexes (§A.4), and app-side post-filtering is forbidden outright. The studied
systems' entry-point validation ("no operation without an owner") is worth copying
verbatim as a code-review rule.

## 5. Exposing memory operations as an API

**Pattern:** The operation set that survives production use is small and stable:
`add(content, scope-ids, metadata) → events`, `search(query, filters, top_k,
threshold)`, `get(id)`, `list(filters)`, `update(id, data)`, `delete(id)`,
`history(id)`. Add returns *what happened* (created/skipped-duplicate), not just IDs.
Every mutation is recorded in an append-only history store.

**Rationale:** The history store is what makes manual correction safe: an update
overwrite is recoverable; an audit question ("when did this change and why") is
answerable. Systems without it have silent last-write-wins updates.

**Application:** Cogeto's memory module public interface mirrors this set, with two
upgrades: `update`/`delete` from users flow through status transitions and the
deletion saga instead of raw row mutation, and history is not an optional side table
but the validity-interval + status-transition record itself.

## 6. Vector-store abstraction: a narrow interface, payload-first

**Pattern:** Supporting multiple vector backends is viable only behind a narrow
interface: `insert(vectors, payloads, ids)`, `search(query-vector, top_k, filters)`,
`update`, `delete`, `get`, `list(filters)` — with two contract rules: all scores
normalized to [0,1] (higher = better), and all metadata carried as an opaque payload
dict the store indexes but never interprets.

**Rationale:** Score-normalization at the adapter boundary is what makes fusion and
thresholds backend-independent; payload-opacity is what keeps domain concepts out of
adapters.

**Application:** Cogeto ships Qdrant-only in v1 but writes this interface anyway —
it is small, and it is also the seam through which `reindex` (rebuild from Postgres)
is implemented. Do not build second-backend support; build the narrow interface.

## 7. What causes memory pollution (observed failure catalog)

Every studied system exhibits some of these; Cogeto's design must close each:

1. **Hallucinated extractions stored as-is** — prompt-only "no fabrication" rules are
   the sole guard in studied systems. → Cogeto: the independent verification pass
   (Addendum §B.3) demotes unsupported facts to `uncertain` before they count.
2. **Contradiction accumulation** — "likes coffee" and "hates coffee" coexist forever;
   downstream apps must disambiguate. → Cogeto: reconciliation sets `contradicted`
   (with a visible warning at retrieval) and supersession sets `replaced`.
3. **Silent overwrites** — update-in-place with no review. → Cogeto: user edits are
   status transitions + interval closes; nothing is silently lost.
4. **Orphaned derived data** — entity links / index entries left dangling after
   partial failures, with warnings logged and nothing retried. → Cogeto: outbox +
   idempotent jobs + the nightly reconciliation sweep (§A.7 step 4).
5. **No provenance** — facts with no record of what produced them, making audit and
   cascade-deletion impossible. → Cogeto: NOT NULL provenance is the schema's most
   load-bearing constraint.
6. **Unbounded custom metadata** — free-form keys shadowing reserved fields.
   → Cogeto: reserved payload keys are a fixed set; custom metadata lives under a
   single nested key.

## 8. Evaluation as a first-class artifact

**Pattern:** Serious memory systems measure themselves with an ingest → search →
judge pipeline over labeled dialogue/document sets: ingest a corpus, ask questions
with known answers, have a judge model score answers produced from retrieved
memories. Metrics: extraction precision/recall, retrieval hit rate, answer accuracy.

**Rationale:** Extraction quality is invisible without this; prompt changes routinely
regress it. The systems that publish benchmark numbers built the harness early.

**Application to Cogeto (summary of everything above):**

| Studied pattern | Cogeto realization |
|---|---|
| Additive writes + async curation | fast path insert, slow path reconciliation |
| Hash dedup then semantic dedup | ingestion store-step hash; reconciliation merge → `replaced` |
| Scope-ids validated at every entry point | NOT NULL `owner_id`/`scope`, forbidden post-filtering |
| History store on all mutations | status transitions + validity intervals (never destroy) |
| Prompt-only hallucination guards (insufficient) | verification pass → `uncertain` (§B.3) |
| Narrow vector-store interface, normalized scores | Qdrant adapter + `reindex` command (§A.4) |
| Ingest→search→judge eval harness | golden set + CI gate, built with the extractor (§B.4) |

The one-line takeaway: the studied systems prove the *pipeline shape* (additive,
hash-dedup, scope-filtered, narrow store interface) and prove by omission why
Cogeto's additions (statuses, provenance, verification, receipts) are the product.

# ingestion — bounded context

The pipeline that turns raw source content into memories (scope doc §4.9, Addendum §B.3):
**ingest → chunk → extract (structured facts) → verify (self-verifying extraction, §B.3)
→ embed + store → reconcile** (dedup, contradiction detection, status updates).

Binding rules:
- Facts, not raw documents, go into the vector store (scope §4.9).
- Extraction runs in the **worker**, never in the request path (§A.1, scope §6).
- Every stored fact carries NOT NULL provenance (§A.6) and enters as `active` only
  after the verification pass; unsupported/partial → `uncertain` (§B.3).
- Extraction/verification prompts are versioned artifacts in `project/prompts/` (§B.7),
  evaluated against the golden set (§B.4) — the eval harness is built WITH the extractor.

May depend on: `memory` public interface (writes via the aggregate), `model-gateway`.
Consumes connector events via the outbox (§A.3); reads source content through the
`SourceReader` port that connectors implement (bound by the worker composition root).

Owns: the `verification_result` table (S2-A) — the verdict that earned each
admitted memory its status. S2-A implements stages 1–4 (`IngestionPipeline`,
one idempotent worker job per source item); stage 5 (embedding, S2-B) and
stage 6 (reconcile, Session 4) are logging stubs.

Read first: `docs/research/retrieval-and-pipeline-patterns.md`,
`docs/research/memory-architecture-patterns.md`.

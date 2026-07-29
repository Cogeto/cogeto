# ingestion: bounded context

The pipeline that turns raw source content into memories (scope doc §4.9, spec §2):
**ingest → chunk → extract (structured facts) → verify (self-verifying extraction, spec §2)
→ embed + store → reconcile** (dedup, contradiction detection, status updates).

Binding rules:
- Facts, not raw documents, go into the vector store (scope §4.9).
- Extraction runs in the **worker**, never in the request path (spec §15, scope §6).
- Every stored fact carries NOT NULL provenance and enters as `active` only
 after the verification pass; unsupported/partial → `uncertain` (spec §2).
- Extraction/verification prompts are versioned artifacts in `project/prompts/` (spec §12.3),
 evaluated against the golden set (spec §14): the eval harness is built WITH the extractor.

May depend on: `memory` public interface (writes via the aggregate), `model-gateway`.
Consumes connector events via the outbox (spec §15.4); reads source content through the
`SourceReader` port that connectors implement (bound by the worker composition root).

Owns: the `verification_result` table (S2-A): the verdict that earned each
admitted memory its status. S2-A implements stages 1 to 4 (`IngestionPipeline`,
one idempotent worker job per source item); stage 5 (embedding, S2-B) and
stage 6 (reconcile, Session 4) are logging stubs.

Read first: `docs/research/retrieval-and-pipeline-patterns.md`,
`docs/research/memory-architecture-patterns.md`.

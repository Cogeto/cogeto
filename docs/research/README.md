# research — distilled engineering patterns

Anonymized, timeless engineering guidance distilled from an in-depth study of several
production systems (a production memory layer for LLM applications, a temporal
knowledge-graph memory system, a widely used agent-orchestration framework, and a
large multi-agent platform studied for project structure). No code was copied; these
document patterns, tradeoffs, and their application to Cogeto.

Required reading before implementing the matching area:

- `memory-architecture-patterns.md` — before `src/memory`, `src/ingestion`.
- `temporal-knowledge-patterns.md` — before `src/memory` (validity intervals, statuses).
- `agent-orchestration-patterns.md` — before `src/agents`, the worker, the outbox.
- `retrieval-and-pipeline-patterns.md` — before `src/retrieval`, `src/ingestion`, prompts.
- `project-structure-lessons.md` — before any structural or CI-boundary work.

Also read `../eval-golden-set.md` before building the extractor or harness.

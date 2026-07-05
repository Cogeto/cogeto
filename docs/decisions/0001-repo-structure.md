# 0001 — Repo structure: modular monolith layout

**Date:** 2026-07-01 · **Status:** accepted · **Governs:** repository layout
**Driven by:** Addendum §A.1 (topology), §A.2 (compose contract), §A.11 (sequencing)

## Problem

The scaffold's original layout (`project/services/*`, `project/packages/*`,
`project/apps/*`) implied a microservices topology — one deployable per directory.
The Addendum locks a **modular monolith**: one codebase, DDD bounded contexts as
internal modules, exactly two deployable processes (app, worker).

## Moves (all content preserved; plain filesystem moves, no git commands run)

| From | To | Why |
|---|---|---|
| `project/services/memory` | `project/src/memory` | bounded context under one source root |
| `project/services/agents` | `project/src/agents` | same |
| `project/services/connectors` | `project/src/connectors` | same |
| `project/packages/model-gateway` | `project/src/model-gateway` | seams are modules like any other (§A.1) |
| `project/packages/identity` | `project/src/identity` | same |
| `project/services/workers` | *dissolved* → `project/src/entrypoints` | "workers" is not a domain; the worker is an **entrypoint** (§A.1) |
| `project/apps/web` | `project/web` | `apps/` implied multiple deployables; web is the frontend served by the app process |

## Created

- `project/src/{ingestion,retrieval,tasks}` — bounded contexts required by §A.1 that
  had no directory.
- `project/src/entrypoints` — app + worker composition roots.
- `project/prompts` — versioned prompt artifacts (§B.7).
- `docs/research/` — anonymized pattern studies; `docs/decisions/` — this log.

## Notes

- `services/` and `packages/` roots were removed; `.gitkeep`-style leftovers cleaned.
- Directory names (`model-gateway`) may be renamed to fit the chosen stack's module
  naming (e.g. underscores); record such a rename as a new decision.
- Application tests live under `project/src/`, next to the code they exercise
  (location decided once coding began).
- The git index still holds the old staged paths; the owner manages git manually and
  will re-stage after this restructure.
- The eval harness (§B.4) gets its directory when built (first coding sessions),
  alongside the extractor — deliberately not pre-created empty.

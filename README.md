<p align="center">
  <img src="assets/brand/cogeto-final-logo-horizontal.svg" alt="Cogeto" width="360">
</p>

# Cogeto

A private, EU-hosted AI command center that turns scattered work context into trusted, correctable long-term memory — and runs human-approved agents on top of it.

> **Cogeto, ergo sum — your mind, extended.**

## What is Cogeto

Cogeto ingests your scattered work context — email, calendar, notes, documents — and turns it into **correctable, inspectable long-term memory** rather than just stored text. Every fact carries a lifecycle status (active, outdated, contradicted, uncertain, replaced, user-approved) plus an orthogonal sensitive flag, is scope-tagged, and stays source-linked, so you can trust it and correct it. Human-approved agents then act on that memory with a human in the loop.

It is **EU-first, privacy-first, self-hostable, and model-agnostic (Mistral-first)**. The moat is the correctable, inspectable memory — not the storage. Primary users are privacy-conscious solo professionals: consultants, founders, freelancers, and small teams.

## Repo layout

- `project/` — the Cogeto product (skeleton only for now).
- `docs/` — authoritative product specification and scope.
- `assets/` — brand assets (logo, icon); trademarked, see [`TRADEMARK.md`](TRADEMARK.md).
- `tests/` — **intentionally unused** (folder marker only, gitignored).

## Status

**Session 2 complete (S2-A + S2-B).** On top of the Session 1 foundation (compose
stack to login, contractual schema, outbox + idempotent queue, Memory aggregate,
identity/model-gateway seams), the Notes vertical slice now runs for real: notes
captured on the **Memories** page go through the six-stage pipeline — ingest →
chunk → extract (versioned prompt `extraction/v0001`) → verify (independent
`verification/v0001`; supported → `active`, partial/unsupported → `uncertain`) →
**embed + store** (batched Mistral embeddings; Qdrant points with native
scope/sensitive payload gates) — with reconcile stubbed for Session 4. Semantic
search is live behind `MemoryStore.vectorSearch`; `npm run reindex` rebuilds
Qdrant from Postgres and verifies counts; `npm run eval` scores the extraction +
verification prompts against the bilingual golden set (`project/eval/golden/`,
results in `docs/eval/history.md`). Next: Session 3 — retrieval fusion, chat, and
the dashboard.

## Licensing

- **Core** is licensed under **AGPLv3** — see [`LICENSE`](LICENSE).
- **Contributions** require a **CLA** — see [`CLA.md`](CLA.md).
- **Commercial licenses** (AGPL exemption) are available — see [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
- The **"Cogeto" name and logo** are trademarks — see [`TRADEMARK.md`](TRADEMARK.md).

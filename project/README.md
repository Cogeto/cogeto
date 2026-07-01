# project/ — the Cogeto application

Cogeto is a **modular monolith**: one codebase, two deployable processes (`app`, `worker`),
packaged with docker compose. Governed by Addendum §A.1 (topology) and §A.2 (compose contract).

- `src/` — the single application source root; one directory per DDD bounded context.
- `web/` — the chat + dashboard frontend, served by the `app` process.
- `prompts/` — versioned, published prompt artifacts (Addendum §B.7).
- `infra/` — docker compose, provisioning, bootstrap configs.

There are **no per-service deployables**. Module boundaries are code boundaries,
enforced by import-linting/architecture tests in CI (Addendum §A.1 rules 1–5).

Build order for the first coding session: migration 0001 (§A.6) → outbox/queue (§A.3)
→ Notes vertical slice (§A.11).

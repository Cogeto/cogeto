# project/: the Cogeto application

Cogeto is a **modular monolith**: one codebase, two deployable processes (`app`, `worker`),
packaged with docker compose. Governed by spec §15 (topology) and (compose contract).

- `src/`: the single application source root; one directory per DDD bounded context.
- `web/`: the chat + dashboard frontend, served by the `app` process.
- `prompts/`: versioned, published prompt artifacts (spec §12.3).
- `infra/`: docker compose, provisioning, bootstrap configs.

There are **no per-service deployables**. Module boundaries are code boundaries,
enforced by import-linting/architecture tests in CI (spec §15 rules 1 to 5).

Build order for the first coding session: migration 0001 → outbox/queue (spec §15.4)
→ Notes vertical slice.

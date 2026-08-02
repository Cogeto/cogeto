# entrypoints: composition roots and CLIs

The app/worker split is an **entrypoint distinction, not a codebase split**
(spec §15). Both processes are built from this one source root:

- **app**: web (chat + dashboard), API, connector endpoints, approval confirm
 endpoints. Serves the fast path only: retrieval + answering, synchronous (scope §6).
- **worker**: all slow-path jobs: extraction, dedup, contradiction checks,
 consolidation/dreaming, deletion sagas, approved-action execution. Runs off the
 Postgres-backed queue (spec §15.4): transactional enqueue via the outbox,
 idempotency key `(source_type, source_id, job_type)`, retries with backoff,
 dead-letter table with dashboard visibility.

Entrypoints are composition roots: they may depend on every module in `src/`;
no module depends on an entrypoint. Nothing slow may run in the request path, ever.

## What belongs here, and what does not

**Only four kinds of file.** This is a rule, not a description: V2.0 item 3.6
part 2 removed seven production controllers and two services that had accreted
here, and the point of writing the list down is that the next one is refused.

1. **Composition roots**: `app-root.module.ts`, `worker-root.module.ts`, and the
 four process entrypoints `app.ts`, `worker.ts`, `migrate.ts`, `preflight.ts`.
2. **Root wiring**: the validated configuration (`config.ts`, `limits.ts`), the
 logger, the boot-time checks (`model-boot.ts`, `redaction-boot.ts`,
 `secret-preflight.ts`), the app-wide exception filter, and the worker's task
 registry, which is the one place a job type is bound to a handler.
3. **Operational and evaluation CLIs**: `dream`, `sweep`, `reindex`,
 `gateway-smoke`, `vector-smoke`, `seed-object`, `seed-orphan`,
 `erase-task-conclusions`, the `demo/` bootstrap, and the eval harnesses
 (`eval`, `eval-chat`, `eval-cache`, `trust-scores`).
4. **Repo-invariant specs**: the checks whose subject is the repository rather
 than a module: the boundary contract, deployment hardening, environment
 consistency, the operator script, the eval gates.

**A controller, a domain service, or anything with its own table never belongs
here.** If a surface spans several contexts, it gets a declared context of its
own (`attention`, `operations`), not a home in a composition root. The
distinction that matters: a composition root *wires* modules together, it does
not *do* anything. `docs/module-boundary-contract.md` is the contract, and
`boundary-contract.spec.ts` enforces it.

The CLIs are the one place raw SQL against another module's tables is
tolerated, because building or asserting on a fixture world is what makes a tool
a tool rather than a request path. Each one is named in the contract's exception
list; none ships in the production image.

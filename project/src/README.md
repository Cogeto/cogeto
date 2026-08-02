# src/: application source root

One directory per DDD bounded context (spec §15): `memory`, `ingestion`, `retrieval`,
`agents`, `connectors`, `passport`, `identity`, `model-gateway`, plus the shared
`infrastructure` leaf, `entrypoints` (app, worker), `migrations` and `testing`.

Module rules (binding, CI-enforced, spec §15):

1. Each module exposes exactly **one public interface** (its `index.ts`); internals
 are private.
2. **No module reads or writes another module's tables**, in Drizzle or in raw SQL,
 and **no barrel re-exports a live table** (spec §15.2). Row *types* may be
 exported; table objects may not.
3. Cross-module communication uses **domain events via the Postgres outbox**
 (spec §15.4). A **job type** is declared once, by the module that owns its payload
 and its handler; everyone else enqueues it through that exported constant.
4. Aggregates own their invariants (e.g. `Memory` owns status transitions).
5. Any module may depend on the two seams (`identity`, `model-gateway`) via their
 public interfaces; domain modules never import each other's internals.
6. **Dependency-injection visibility is part of the boundary** (spec §15.1): a module
 is global only if it is infrastructure or a seam registered once per composition
 root. Where a provider must cross against the graph, the owning module defines a
 port and the composition root passes the implementing module through that module's
 registration options (`sourceDeletions.imports`, `derivedCascades.imports`,
 `IngestionModule.register({ imports })`).

**The contract, with the owner of every table, job type and DI token, the
global-module policy, what enforces each rule and every recorded exception:**
[`docs/module-boundary-contract.md`](../../docs/module-boundary-contract.md).
Enforcement is `npm run boundaries` (imports) plus
`entrypoints/boundary-contract.spec.ts` (ownership, job types, tokens, globals).

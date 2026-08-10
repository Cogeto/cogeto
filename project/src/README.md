# src/: application source root

One directory per DDD bounded context (spec §15): `memory`, `ingestion`, `retrieval`,
`chat`, `agents`, `notes`, `files`, `email`, `research`, `skills`, `settings`,
`passport`, `attention`, `operations`, `sources`, `imports`, `reports`, `providers`,
`identity`,
`model-gateway`, plus the shared `infrastructure` leaf, `entrypoints` (app,
worker), `migrations` and `testing`.

The old `connectors` context (7.9k lines, six unrelated families) was split in
V2.0 item 3.6 part 4 into `notes`, `files`, `email`, `research`, `skills` and
`settings`, and chat-the-connector left `retrieval` for its own `chat` context.
Each family owns its tables, its job types and its public interface; nothing
is global except the four policy-approved infrastructure/seam modules
(`docs/module-boundary-contract.md` §4).

`attention` (the "what needs my attention" feed and the dashboard statistics) and
`operations` (health, the capability registry, queue administration, the audit
browse) are the two surfaces that genuinely span several contexts. They are
declared contexts because of that, **not** residents of a composition root:
V2.0 item 3.6 part 2 moved them out of `entrypoints/`, which had accreted seven
production controllers and two services. V2.2 added `sources` (item 5.2, the
Sources surface's read context, no tables) and `imports` (item 5.3, bulk
import: the manifest, the queued coordinator and the first-class import
record, owning `import_run` + `import_item`). V2.3 added `reports` (item 6.2,
the findings report: the signed PDF + JSON artifact from a findings run,
owning the `findings_report` run ledger and generating everything else
through the owners' gated reads). V2.4 added `providers` (item 7.1: the
instance's model and provider configuration, moved out of the environment into
six tables with the API keys encrypted at rest under the instance master key,
which stays in the environment because a key that guards a database cannot live
inside it).

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

7. **A module never imports a composition root.** Configuration a module needs is
 declared as that module's own options type and mapped by the root that registers
 it (`OperationsOptions`, `WebConfigOptions`, `MemoryModuleOptions`, …). Injecting
 the root's whole `CogetoConfig` is how seven surfaces ended up depending on an
 entrypoint.

**The contract, with the owner of every table, job type and DI token, the
global-module policy, what enforces each rule and every recorded exception:**
[`docs/module-boundary-contract.md`](../../docs/module-boundary-contract.md).
Enforcement is `npm run boundaries` (imports) plus
`entrypoints/boundary-contract.spec.ts` (ownership, job types, tokens, globals).

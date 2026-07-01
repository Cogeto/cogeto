# src/ — application source root

One directory per DDD bounded context (Addendum §A.1): `memory`, `ingestion`, `retrieval`,
`agents`, `connectors`, `tasks`, `identity`, `model-gateway`, plus `entrypoints` (app, worker).

Module rules (binding, CI-enforced — Addendum §A.1):
1. Each module exposes exactly **one public interface**; internals are private.
2. **No module reads or writes another module's tables.**
3. Cross-module communication uses **domain events via the Postgres outbox** (§A.3).
4. Aggregates own their invariants (e.g. `Memory` owns status transitions).
5. Any module may depend on the two seams (`identity`, `model-gateway`) via their
   public interfaces; domain modules never import each other's internals.

Directory names may be adapted to the chosen stack's naming rules (e.g. `model_gateway`)
in the first coding session — record the rename in `docs/decisions/`.

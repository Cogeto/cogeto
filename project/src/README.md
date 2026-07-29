# src/: application source root

One directory per DDD bounded context (spec §15): `memory`, `ingestion`, `retrieval`,
`agents`, `connectors`, `identity`, `model-gateway`, plus `entrypoints` (app, worker).

Module rules (binding, CI-enforced, spec §15):
1. Each module exposes exactly **one public interface**; internals are private.
2. **No module reads or writes another module's tables.**
3. Cross-module communication uses **domain events via the Postgres outbox** (spec §15.4).
4. Aggregates own their invariants (e.g. `Memory` owns status transitions).
5. Any module may depend on the two seams (`identity`, `model-gateway`) via their
 public interfaces; domain modules never import each other's internals.



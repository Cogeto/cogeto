# Task removal (V2.0 items 3.1 + 3.2)

Working notes for the 2.0 opening move. The binding record is
[decision 0060](../decisions/0060-task-removal.md); the plan is
[`docs/Cogeto-V2-Plan.md`](../Cogeto-V2-Plan.md) §3.1/§3.2; the inventory came
from [`docs/audits/current-state-2.0.md`](../audits/current-state-2.0.md) §2 and
was verified against the code rather than trusted.

## What the shape of it is

One sentence: **an open loop is a memory now.**

```
before                                  after
------                                  -----
memory (kind=commitment)                memory (kind=commitment)
   └── tasks.derive job                     · valid_until   → due date
       └── task row                         · dormant_flag  → gone quiet
            · due                           · status        → still standing?
            · condition_text
            · dormant  (mirror of flag)  MemoryStore.openLoopsForPrincipal
            · status   (own lifecycle)      └── RetrievalService.openLoops
            · from_uncertain                     ├── chat: open_loops mode
       └── closure/condition judgments          └── attention: due/overdue/quiet
       └── task_conclusion → memory
```

Everything on the left is gone. Everything on the right already existed except
the two read methods.

## The one ordering constraint

`task_conclusion` memories must be erased **through the deletion saga** before
migration 0035 drops the table they point at, or their provenance strands and
the nightly sweep flags them (decision 0024).

```sh
npm run erase:task-conclusions   # signed receipt per source; idempotent
npm run migrate                  # 0035 refuses to run if any survive
```

The migration's guard is a `RAISE EXCEPTION`, not a comment — skipping the step
fails at migrate time, loudly, rather than silently later. On an instance that
never had tasks (which is all of them but the owner's dev box) the erase script
prints "nothing to erase" and exits 0.

## The three published contracts, and what each cost

| Contract | What it cost |
| --- | --- |
| Signed deletion receipts | Nothing structural. `canonicalize`/`verifyChain` untouched; `counts_json.tasks_removed` stays optional **forever** (the executor re-parses stored receipts on retry, so it is contract, not dead code); new receipts omit it. Pinned by `receipt-chain-tasks-removed.spec.ts`. |
| Memory Passport | A breaking version bump, 1.0 → 2.0, per decision 0029 ruling 2. `docs/passport-schema/` is now `1.0/` + `2.0/`; 1.0 archives stay valid and verifiable forever. |
| `source_type` enum | Permanent residue: Postgres cannot drop `'task_conclusion'`. It joins `'calendar_event'` in `DEFUNCT_SOURCE_TYPES` — a *known* value with no producer, never an error. The sweep gained an arm that proves no row carries one. |

## Gotchas worth remembering

- **Positional DI order is load-bearing.** `ChatService` lost its `tasksEngine`
  parameter, which shifted `skillResolver` from position 10 to 9 — every
  positional harness construction (eval-chat + five integration specs) had to
  move with it. Same class of trap as the P7 "append LAST" note.
- **`RetrievalService`'s third parameter changed meaning** (`TasksEngine` →
  optional `Db`). It is `@Optional()` so bare unit constructions with two
  arguments still work, but any harness passing three positionally had to be
  read, not assumed.
- **Retrieval now imports ingestion** (the dormant-flag consumption API, via the
  barrel). Acyclic — `ingestion` imports nothing from `retrieval` — and the edge
  already existed for `resolveExpression`, so dependency-cruiser was always
  going to allow it. Worth knowing it is deliberate.
- **Historical migrations were edited.** 0014 and 0030 each ended with a
  `graphile_worker.add_job` for a now-handlerless job type, and migrations
  replay from 0001 on every fresh database. The schema statements are untouched;
  only the enqueue is removed. This is safe *specifically because* the ledger
  records file names, not checksums.
- **The eval trap cases were kept, not deleted.** `en-e004`, `en-f001`,
  `en-w002` and their hr twins lost their `expected_tasks` assertion but keep
  their ids and every extraction label — deleting them would have silently
  shrunk the corpus and made published scores incomparable.
- **`en-t*`/`hr-t*` and `task-pair.json` are genuinely gone** — those scored the
  task engine's own closure and condition judgments, which no longer exist.
- **The demo seed's assertions now count open loops**, not task rows, using the
  same kind/status predicate `openLoopsForPrincipal` applies. If the two ever
  drift, the demo starts lying about the world it built.

## What survived that the audit predicted would not need to

The audit's §2.4 list was accurate: `commitment`/`open_loop` kinds, the
`dormant_flag` table, the attention surface and the open-loops chat path were
all already outside the tasks module or trivially re-fed from memory. Only
reminders needed rebuilding, and 3.2 says do not — so nothing did.

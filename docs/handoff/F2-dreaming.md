# Handoff F2 → F3/v1.x: dreaming data contracts, the digest card, dormant flags

**Status: FROZEN.** Later sessions implement against this spec without
redesigning it; deviations need owner sign-off first. Authority: Addendum
§B.6, decisions 0010 and 0011, migration 0012.

## 1. dream_run + dream_action (the run ledger)

- `dream_run`: `id · started_at · finished_at (NULL = crashed; window gets
  re-covered) · scope_from · scope_to · counts_json`. The NEXT run's
  `scope_from` = the last FINISHED run's `scope_to`. One row per run,
  including empty runs.
- `dream_action`: `id · run_id (FK CASCADE) · pass ('dedup' | 'contradiction'
  | 'supersession' | 'staleness' | 'dormant') · memory_id · related_memory_id
  · relation_id · created_at`. Semantics per pass: dedup → memory=survivor,
  related=loser; supersession → memory=winner, related=loser; contradiction →
  memory=incoming fact, related=existing, relation_id set; staleness/dormant →
  memory=the memory itself. Memory FKs CASCADE — deleted memories take their
  dream traces with them; that is what keeps digest links resolvable.
- Both tables are **ingestion-owned**. Nobody else reads or writes them;
  consumers go through `GET /api/dreaming/latest` or ingestion's public API.

## 2. The digest card contract (v1.x morning chat card)

v1 ships the plain Dashboard panel ("While you were away", ≤6 lines). The
v1.x card is the SAME data, chat-surfaced, with tighter constraints:

- **Three lines maximum**, chosen by the v1 priority order: conflicts, then
  merges/updates, then quiet commitments, then the outdated aggregate;
  everything else folds into the last line's count.
- **One card per day**: the card renders the latest FINISHED `dream_run` once;
  re-opening chat the same day re-shows the same card, never a second one.
- **Silence on empty**: zero caller-visible lines ⇒ no card at all (no empty
  state, no "nothing happened" copy).
- **Every line deep-links**, exact targets (same grammar as the panel):
  conflict → `/review?tab=contradicted`; merge/update →
  `/memories?open={survivor|winner id}`; quiet commitment →
  `/memories?open={memory id}`; outdated aggregate →
  `/memories?status=outdated`; fold line → `/memories`.
- **Scoping is the gate, not a filter**: lines exist only for memories the
  caller can read via `getManyForPrincipal`. Reuse `GET /api/dreaming/latest`
  verbatim — the card is a renderer, not a second pipeline.

## 3. dormant_flag (what the F3 task engine consumes)

- Fields: `id · memory_id (FK CASCADE) · run_id · reason (free text, e.g.
  "no activity for 14 days") · flagged_at · cleared_at (NULL = open)`. One
  OPEN flag per memory (partial unique index) — re-flagging is a no-op.
- A flag is a **signal, never a status**: the memory stays `active`. The
  silence window lives in the versioned reconcile config
  (`DORMANT_SILENCE_DAYS`, v1: 14).
- **Who clears:** (a) dreaming, when the memory is no longer `active`
  (resolved, superseded, outdated, deleted); (b) the F3 task engine, by
  setting `cleared_at` when the derived task closes — through ingestion's
  public API, which F3 gets extended with a `listDormantFlags` /
  `clearDormantFlag` pair when it lands. F3 treats an open flag as "commitment
  with no recorded resolution, gone quiet" — prime open-loop material.
- F3 derives tasks FROM flags; it never mutates the memory (tasks read memory
  through its public interface — glossary).

## 4. What future sessions must NOT do

- **No second scheduler.** Graphile cron in the worker is the only scheduler;
  new nightly work is a new crontab line + task, nothing else.
- **No digest writes outside dream_run/dream_action.** The digest (panel or
  card) is a pure read of the latest run; anything that wants to appear in it
  must be a dream pass writing `dream_action` rows.
- **No new status transitions.** Dreaming's only transition is staleness →
  `outdated` as the consolidation actor. Dormancy stays a flag; the F3 task
  engine derives tasks and clears flags but never touches `memory.status`.
- **No direct table access** to dream_run / dream_action / dormant_flag from
  other modules, and no digest queries that join the memory table — memory
  details resolve through the gated MemoryStore reads only.

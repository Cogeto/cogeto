# Session S3-A — retrieval fusion + chat

**Date:** 2026-07-03 · **Scope:** S3-A owner prompt, sections 1–6. The dashboard
is S3-B. Numbering note: the prompt's "decision 0004" landed as **decision 0006**
(0004/0005 were taken by S2) and its "migration 0002" as **migration 0005**
(0002–0004 were taken by S1-B/S2) — content as specified.

## What shipped

### Decision 0006 + migration 0005

- Four rulings recorded: FTS = `simple` + `unaccent`; entities as `text[]` +
  GIN trigram on the memory row; edit = supersession, never mutation; review
  rejection = audited memory-level deletion via the aggregate (receipts stay
  source-level).
- `0005_retrieval_and_chat.sql`: `unaccent` + `pg_trgm` extensions; immutable
  wrappers `cogeto_unaccent` / `cogeto_entities_text` (the stock functions are
  STABLE and disqualified from generated columns / expression indexes);
  `memory.entities text[] NOT NULL DEFAULT '{}'` + GIN trigram index;
  generated `content_tsv` (simple, unaccented) + GIN index; `chat_message`
  (id, owner_id, role, content, created_at) owned by retrieval's chat area.
- **Entities backfill:** nothing to backfill from — extraction output is
  transient by design (chunks/candidate facts are never stored; the migration
  records this). Pre-S3 rows keep `'{}'` and miss only the entity signal until
  re-ingested; FTS and vector still cover them. The pipeline (stage 5) now
  persists each fact's people/organizations/projects, flattened and deduped,
  onto the memory row.

### Memory module — the two remaining primitives

- `ftsSearch(principal, query, opts)` — `websearch_to_tsquery` over
  `content_tsv`, score = `ts_rank_cd(…, 32)` (rank/(rank+1) → [0,1)).
- `entitySearch(principal, names, opts)` — pg_trgm `%` match of query names
  against the entities array; score = best `similarity()` pair.
- Both apply the scope + sensitive gates **inside the SQL** (`visibleTo`, the
  same private builder every read uses); sensitive stays owner-only opt-in.
  `getManyForPrincipal(principal, ids)` added as the gated batch read that
  resolves vector id-hits. Raw tables remain module-private; an unscoped read
  is still unrepresentable through the public interface.

### Retrieval module — fusion

- `RetrievalService.retrieve(principal, query, opts)` — the one public read:
  embed the query via the gateway (the only model call on this path), run the
  three primitives with 4× over-fetch, fuse with RRF (k=60 in
  `retrieval-config.ts`), apply the §A.5 multipliers exactly (active 1.0,
  user_approved 1.0, uncertain 0.6, contradicted 0.4, outdated 0.2, replaced
  0.0 = excluded). Per result: the row (status, sensitive, source ref) + which
  signals hit. Fusion itself is a pure function (`fusion.ts`) for testability.
- Query entities: capitalized-token heuristic (consecutive tokens group into
  one name; en+hr stopword list in config) — no model call; the trigram match
  in SQL is what "matches against known entities". No temporal queries yet.

### Chat (fast path only)

- `POST /api/chat` — SSE (`sources` → `token`* → `done`); `GET
  /api/chat/messages` — persisted history. Both messages persist to
  `chat_message`; **nothing is enqueued** — retrieval + generation only.
- Answer context = structured fact blocks (claim, status, source label,
  validity) via prompt family **answer/v0001** (registered on worker boot with
  the immutability hash check): answer only from facts, cite with inline
  `[F#]` markers, plain "nothing on record" + capture suggestion when facts
  are missing, status/validity caveats in prose, answer in the question's
  language.
- Zero retrieval short-circuits to the canned nothing-on-record answer with
  **no model call**.
- Citations persist as stable `[[mem:<id>]]` markers (assistant content is
  rewritten before insert), so history renders chips after the live sources
  list is gone; `GET /api/memories/:id` added for chip resolution.
- `ModelGateway.completeStream()` added to the seam (Mistral streaming; no
  provider types cross the boundary).

### SPA

- Chat nav section enabled: message list, streaming render, citation chips
  colored by status (uncertain/contradicted visibly marked ⚠) that open the
  source drawer; empty-memory welcome state; failure state on stream errors.
  SSE parsed off a fetch body stream (EventSource cannot POST a bearer token).
  SourceDrawer extracted into a shared component.

## Interfaces added

| Interface | Where |
|---|---|
| `MemoryStore.ftsSearch(principal, query, opts)` | memory public interface |
| `MemoryStore.entitySearch(principal, names, opts)` | memory public interface |
| `MemoryStore.getManyForPrincipal(principal, ids, opts)` | memory public interface |
| `RetrievalService.retrieve(principal, query, opts)` | retrieval public interface |
| `ModelGateway.completeStream(request)` | model-gateway seam |
| `POST /api/chat` (SSE), `GET /api/chat/messages` | retrieval/chat HTTP |
| `GET /api/memories/:id` | memory HTTP |

Prompt versions: extraction/v0001, verification/v0001, **answer/v0001** (new).

## Tests (all green)

| Test | Result |
|---|---|
| `fts_gated` (memory) | pass — B's private/sensitive never reach A; owner-only sensitive opt-in; + diacritics case (ruling 1) |
| `entity_gated` (memory) | pass — same gates through the trigram path; case-insensitive; empty/no-match safe |
| `fusion_multipliers` (retrieval) | pass — deterministic RRF order; replaced never appears; outdated < active at equal raw rank; full §A.5 table |
| `chat_grounding` (retrieval) | pass — context = retrieved facts only (B's row absent); zero retrieval → nothing-on-record, no generation |
| `chat_fast_path` (retrieval) | pass — no outbox events, no queued jobs from asking |
| All S1/S2 suites | pass — 31 tests + 1 live-optional across 11 files |

Full battery: build, lint, boundaries (141 modules, 0 violations), `docker
compose up` → login with all 7 containers healthy; migration 0005 applied by
the init container; worker boot registers answer/v0001 and reports the vector
collection ready.

## Demo questions to try

After capturing e.g. *"Maja needs the revised Arkona contract before Thursday,
and Vedran still owes me the Meridian figures"*:

1. "What do I owe Maja?" — cited answer; chip opens the note.
2. "Tko mi još duguje brojke?" — Croatian in, Croatian out, same facts.
3. "What is happening with the Arkona contract?" — FTS + entity + vector agree.
4. "What did I decide about the Berlin office?" (nothing captured) — plain
   "nothing on record" + capture suggestion, no invention.

## Owner verification checklist

1. `docker compose up` → login; **Chat** is enabled in the nav.
2. Capture a note on **Memories**; wait for it to appear in the list.
3. Ask about it in **Chat** — the answer streams, carries a citation chip with
   the memory's status color, and the chip opens the original note.
4. Ask something you never captured — the "nothing on record" reply, no
   invention (and `docker compose logs worker` shows no new pipeline job from
   chatting).
5. Reload the page — the conversation persists; chips still resolve.
6. `docker compose logs worker | grep "prompt version registered"` → three
   families including `answer v0001`.

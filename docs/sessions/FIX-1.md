# Session FIX-1 — Content leakage & deletion completeness (QS-1, QS-13, QS-7, QS-28, QS-16)

**Model:** Fable 5. **Implements:** the audit's QS-A cluster
(`docs/audits/quality-security-audit.md`) — what the deletion receipt honestly
claims, and what the org-readable audit trail may carry. **Decision:** `0025`
(audit content hygiene, chat-answer cascade, sweep completeness — including the
consciously-chosen boundaries). **Migration:** `0020`
(audit_log.owner_id, memory_relation.reason, and the sanctioned scrub).
**No new dependency.** Follows QS-B (decision 0024) in the same audit-fix
series; FIX-2 and FIX-3 run with Opus 4.8.

## QS-1 + QS-13 — the audit trail carries no content, and detail is owner-gated

The audit refuted 0020 ruling 6: the model's contradiction `reason` — a
sentence naming values from **private** memories — was persisted in
`audit_log.detail_json`, org-readable, append-only, deletion-surviving. Fixed
on all four axes:

1. **Writers.** `writeAudit`'s contract now states detail is STRUCTURAL
   METADATA ONLY (ids, kinds, transition names, counts). Every free-text
   `reason` was removed from audit detail: status transitions (`{from,to}`),
   merges (`{survivor,enriched}`), supersessions (`{supersededBy,mechanism}`),
   task closure/unblock (`{byMemoryId}`), task dismissal (`cause:
   'superseded_duplicate'` — coded, not free-text), the pipeline abort
   (`cause`). The transition/merge/supersession `reason` parameters remain as
   advisory context but are never persisted (documented at each signature).
2. **Where explanations live instead.** The contradiction reason moved to
   **`memory_relation.reason`** (migration 0020) — the owner-gated row the
   Review queue reads — surfaced via `ContradictionDto.reason` ("Why it was
   flagged" in the Review card) and erased with the pair. Verification
   rationale already lived on `verification_result`. Merge/supersession/
   closure rationales are deliberately not persisted anywhere (0025 ruling 1
   justifies: the pointer/flag/closing-id is the durable why).
3. **Stamps.** `audit_log.owner_id` (new) on every owner-concerning writer;
   `org_id` from the Principal where present, else resolved through the
   identity seam (`UserDirectory.orgOf`, memoized; optionally injected into
   MemoryStore, MemoryReconciliation, TasksEngine — the audit's four NULL-org
   writers). Genuine system entries (sweep, dreaming summary, chain
   confirmation) stay NULL-org/NULL-owner by design: instance-level counts.
4. **Reader.** `GET /api/audit` keeps the org gate for entries but returns
   `detail_json` only to the stamped owner; peers get `detailWithheld: true`
   and the UI says "Details visible to the entry's owner only." Defense in
   depth on top of (1).
5. **The scrub — pre-existing rows.** Migration 0020 disables the append-only
   trigger for one UPDATE, strips the `reason` key from every existing row,
   re-enables the trigger, and **audits itself** (`audit.detail_scrubbed`).
   This is the sanctioned-migration erasure path migration 0001 explicitly
   reserved; recorded in 0025. **Live evidence: the demo instance had 241
   rows carrying model reason text — all scrubbed, zero remaining**
   (`SELECT count(*) FROM audit_log WHERE detail_json ? 'reason'` → 0).

Tests: `detail_owner_gated` (same-org peer sees the entry, not the detail),
`scrub_migration` (replays 0020 — written idempotently for this — against a
legacy-shaped row: reason gone, `{a,b}` kept, scrub audited, trigger back in
force), and the reconcile suite asserts the relation row carries the reason
while the audit row does not.

## QS-7 — chat answers citing erased memories: the cascade (recommended option)

Implemented the cascade, not the documentation boundary (0025 ruling 2
justifies against the alternative): `ChatAnswerCascade` joins the
`DerivedCascade` family (retrieval implements, both roots bind). At deletion
time, every **assistant** message whose stored text carries a
`{{cite:<memory id>}}` token for an erased memory is redacted to
*"This answer referenced information that has since been deleted."* — the
timeline survives, the content doesn't. Key properties, each tested:

- **Historical coverage without backfill**: the linkage is the stored citation
  token itself (decision 0007 ruling 2), present in every answer ever stored.
- **Cross-owner on purpose**: a peer's answer quoting the owner's shared fact
  is redacted too — erasure must not be reconstructable from someone else's
  chat history.
- **Idempotent**: redaction removes the tokens; a later deletion can neither
  re-match nor double-count.
- **User turns untouched**: their own words, deletable as chat sources in
  their own right (0021).
- **Receipt honesty**: `counts_json.chat_messages_redacted` (additive,
  optional — same precedent as `tasks_removed`; canonicalization untouched),
  shown in the Forgotten ledger ("N chat answers redacted") and in the
  printable receipt's verbatim counts. The audit's deletion-completeness
  table row flips to **Yes**.

## QS-28 — orphan objects: sweep arm + honest compensating deletes

- The two `deleteObject(...).catch(() => undefined)` in the upload abort
  windows became `cleanupOrphanObject`: 3 in-line attempts with backoff,
  WARN per failure, ERROR naming the orphan key on exhaustion (keys are
  identifiers — the pino no-content rule holds), with the sweep as the named
  backstop.
- New nightly **orphan-object arm**: `MemoryObjectStore.listObjects`
  (ListObjectsV2, paginated) scans the bucket; objects older than the grace
  window (default 60 min — clears both the PUT-before-metadata-commit window
  and the 15-minute staging backstop) alert as `orphaned_object` when they
  have no `file_metadata` row, and staging objects that outlived their
  cleanup alert too. Detection only — byte deletion stays the saga's
  monopoly. Injection-fixture test: unaccounted object + stale staging object
  flagged past the window; fresh and accounted objects not; bytes untouched.

## QS-16 — payload consistency: full-scan arm with self-heal

New nightly **payload-consistency arm**: every embedded live row's
gate-relevant fields (`owner_id`, `scope`, `status`, `sensitive`) compared
against its Qdrant payload in keyset pages of 500. **Full scan, not a sample**
(justified in 0025: ~200 Qdrant calls per 100k memories nightly, and a sample
can't promise one-cycle detection). Mismatch → `payload_mismatch` alert AND
self-heal via the same idempotent targeted `setPayload` the write paths use;
an embedded row with no point alerts for `reindex` (no self-heal — there is
no vector to write). The alert copy states the honest severity in so many
words: *"recall/consistency only, not a leak: retrieval re-gates every hit
through Postgres."* Tested: flag + heal + honest copy + idempotent re-run
(0 healed, 0 new alerts on the second pass).

## QS-22 overlap (deliberately NOT fixed here — FIX-3)

`dead_letter.error` can still embed model fragments; deep log redaction is
FIX-3's. FIX-1's obligation was narrower and is met: nothing added this
session writes content to logs, dead_letter, or audit detail — the cascade
logs counts, cleanup logs object keys, sweep alerts carry ids + field names.

## Files touched (essentials)

Migration `0020_audit_provenance_and_scrub.sql`. Infrastructure: `audit.ts`
(+ ownerId, detail contract), `persistence/tables.ts`. Identity:
`user-directory.ts` (+ `orgOf`). Memory: `memory.store.ts` (stamps; reason
never persisted), `reconciliation.ts` (relation.reason; stamps; advisory
reasons), `deletion-saga.ts` (chat count in counts_json; owner stamps),
`integrity-sweep.ts` (two new arms + `SweepOptions`), `persistence/tables.ts`
(+ relation.reason), `persistence/object-store.ts` (+ `listObjects`),
`receipts.controller.ts`, `relations.controller.ts`, `index.ts`,
`sweep-arms.integration.spec.ts` (new). Retrieval: `chat/chat-answer-cascade.ts`
(new) + module/exports + `chat-answer-cascade.integration.spec.ts` (new).
Tasks: `tasks.engine.ts`. Agents: `approval.service.ts`, `approval.executor.ts`.
Connectors: `files.service.ts` (retried cleanup), `user-settings.service.ts`.
Entrypoints: `audit.controller.ts` (detail gate), `jobs.controller.ts`,
`sweep.ts` (new counters + adapters), both roots (ChatAnswerCascade),
`audit.integration.spec.ts` (new tests). Shared: `audit.ts`, `notes.ts`,
`receipts.ts`. Web: `Audit.tsx`, `Review.tsx`, `Forgotten.tsx`. Docs: decision
0025, audit RESOLVED lines + deletion-completeness table, this log.

## Verification (definition of done)

- Full Vitest suite: **207 passed + 2 skipped** (42 files). Lint (eslint +
  prettier), dependency-cruiser (287 modules), `tsc` builds: green.
- Compose: `migrate` image rebuilt explicitly (the known stale-image gotcha),
  migration 0020 applied on the live stack (`1 applied now`), app + worker
  healthy, `/api/health` all-ok, login page 200.
- Complete sweep run live with ALL arms: 20 receipts / 671 identifiers,
  objects scanned, payloads compared, **0 alerts, chain ok** — and the scrub
  evidence above (241 rows redacted, 0 remaining).
- Both eval suites run once post-change (golden set + chat) — gates green
  (outputs in the session transcript); no prompt or model changed this
  session, so the gates measure drift only.
- Binding invariant tests (scope-leak, deletion-cascade incl. the new chat
  arm, approval-gate) green.

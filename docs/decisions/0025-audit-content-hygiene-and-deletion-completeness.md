# 0025 — Audit content hygiene, chat-answer cascade, and the sweep's completeness arms (FIX-1: QS-1, QS-13, QS-7, QS-28, QS-16)

**Status:** Accepted. **Context:** the quality/security audit
(`docs/audits/quality-security-audit.md`) refuted decision 0020 ruling 6's
claim that "no detail field contains content": the model's one-sentence
`reason` (naming values from **private** memories — "Fact A says €48,000,
Fact B says €52,000") was persisted in the org-readable, append-only
`audit_log`, survived deletion, and reached every org member (QS-1), while
four writers stamped no `org_id` at all (QS-13). Related completeness gaps:
chat answers kept quoting deleted facts (QS-7), orphan objects and stale
Qdrant payloads were invisible to the sweep (QS-28, QS-16). This record fixes
the rulings; **migration 0020** carries the schema and the scrub.

## Ruling 1 — audit detail is structural metadata, and detail is owner-gated

1. **No content in `audit_log.detail_json`, ever.** Detail carries ids, kinds,
   transition names, counts, booleans — never memory/note/chat content and
   never model free-text. The `writeAudit` contract documents this; every
   writer was brought into line: transition/merge/supersession/task-closure
   audits carry no `reason`; the task-dismissal marker became a coded `cause`.
2. **Where explanations live instead** — the owner-gated domain row each one
   serves: the verifier's rationale was already on `verification_result`;
   the contradiction explanation now lives on **`memory_relation.reason`**
   (new column, exposed via `ContradictionDto.reason` for the Review queue)
   and is erased with the pair (FK CASCADE). Merge/supersession/task-closure
   rationales are deliberately not persisted anywhere: the supersession
   pointer, enrichment flag, and closing-memory id are the durable, inspectable
   "why"; the model's sentence about them added content risk and no
   verifiability. (Consequence: the transition `reason` parameter is now
   advisory-only and never persisted.)
3. **Provenance stamps on every writer.** `audit_log.owner_id` (new) marks
   whose artifact an entry concerns; `org_id` is stamped from the Principal
   where one exists and otherwise resolved through the identity seam's
   directory (`UserDirectory.orgOf`, memoized), injected optionally into the
   memory store, reconciliation, and the tasks engine. Genuine system entries
   (sweep runs, dreaming summary, chain confirmations) stay NULL-org/NULL-owner
   by design — their detail is instance-level counts. Bare test/fixture
   constructions without the directory produce NULL-org rows; acceptable
   because of the next point.
4. **Reader gate.** `GET /api/audit` keeps its org scope for ENTRIES (the
   org-wide who-did-what trail), but returns `detail_json` only when the
   caller IS the stamped owner (or the entry is ownerless). Non-owners get
   `detailWithheld: true`. This is defense in depth on top of rule 1 — it
   holds even if a future writer slips content into detail.
5. **The scrub (recorded redaction).** Migration 0020 removes the `reason` key
   from every existing audit row, with the append-only trigger disabled for
   exactly that statement and re-enabled after. This is a deliberate,
   sanctioned redaction of leaked content — precisely the "erasure obligations
   are handled by dedicated migrations" escape hatch migration 0001 reserved —
   and it is itself audited (`audit.detail_scrubbed`, with the row count).
   Pre-existing rows therefore satisfy the same guarantee as new ones.

## Ruling 2 — chat answers citing erased memories are redacted (cascade, not a documented boundary)

The recommended option was implemented: erasure extends to derived
conversation content. At deletion time the saga's `DerivedCascade` family
gains `ChatAnswerCascade` (retrieval implements, roots bind): every
**assistant** message whose stored text carries a `{{cite:<memory id>}}`
token for an erased memory has its content replaced with the marker
*"This answer referenced information that has since been deleted."* —
the turn survives (timeline preserved), the content does not.

- **Linkage:** the stored citation tokens themselves (decision 0007 ruling 2)
  — which is why the cascade covers every HISTORICAL answer with no backfill,
  and why it is idempotent (redaction removes the tokens; nothing re-matches).
- **Cross-owner on purpose:** a peer's answer that quoted the owner's shared
  fact is redacted too. Erasure of the fact must not be reconstructable from
  someone else's chat history.
- **Receipt honesty:** the count lands additively in
  `counts_json.chat_messages_redacted` (same additive precedent as
  `tasks_removed`; old receipts parse unchanged, the canonicalization
  algorithm is untouched) and surfaces in the Forgotten ledger ("N chat
  answers redacted").
- **User messages are never touched**: they are the user's own words, and
  remain deletable as chat sources in their own right (decision 0021).
- Rejected alternative — the documentation boundary ("the receipt proves less
  than it claims, and says so"): honest but weaker; since the citation
  linkage already exists in stored form, the cascade costs one UPDATE per
  deletion and makes the claim true instead of caveated.

## Ruling 3 — the sweep completes its coverage (QS-28, QS-16)

- **Orphan objects** (QS-28): the nightly sweep lists the bucket
  (`ListObjectsV2`) and flags any object older than a grace window (default
  60 min — clears the PUT-before-metadata-commit window and the 15-minute
  staging backstop) that has no `file_metadata` row, plus staging objects
  that outlived their cleanup. Detection only (`orphaned_object` alerts):
  deleting bytes remains the saga's monopoly. The upload path's compensating
  deletes lost their silent `.catch(() => undefined)`: they now retry
  in-line with backoff and LOG on failure, with the sweep as the named
  backstop.
- **Payload consistency** (QS-16): the sweep compares every embedded live
  row's gate-relevant fields (`owner_id`, `scope`, `status`, `sensitive`)
  against its Qdrant payload and **self-heals** mismatches with the same
  targeted `setPayload` the write paths use (idempotent); a missing point is
  flagged for `reindex`. **Full scan, not a sample**: one batched
  point-retrieve per 500 rows nightly is trivial at v1 scale (100k memories
  ≈ 200 Qdrant calls), and a sample cannot promise detection within one sweep
  cycle. The alert copy states the honest severity — retrieval re-gates every
  hit through Postgres, so a stale payload distorts **recall**, never
  visibility: "not a leak" is in the alert text so the System view never
  overstates it.

## QS-22 overlap (not fixed here — FIX-3)

`dead_letter.error` can still embed model-output fragments from gateway
errors; that fix (deep log redaction + error serializers) belongs to FIX-3.
This session's rule is narrower and holds for its own changes: nothing added
in FIX-1 writes content to `dead_letter`, logs, or audit detail — the chat
cascade logs counts, the cleanup logs object keys (identifiers), the sweep
alerts carry ids and field names.

## What changed in user-facing language

- Forgotten ledger rows add "N chat answers redacted" when the cascade fired;
  the receipt's canonical `counts_json` (already rendered verbatim in the
  printable receipt) now includes `chat_messages_redacted`.
- The Audit page marks withheld detail: "Details visible to the entry's
  owner only."
- Review's contradiction queue can now show WHY a pair was flagged
  (`ContradictionDto.reason`) — the explanation moved to the surface it
  serves instead of the org-wide trail.

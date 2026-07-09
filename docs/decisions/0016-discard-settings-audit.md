# 0016 — Extract-and-discard, Settings, and the audit reader (Session O1-C)

**Date:** 2026-07-08 · **Status:** accepted · **Governs:** extract-and-discard
mode, the per-user Settings surface, the read-only audit-log reader, and the
supporting migration. **Driven by:** the frozen F1 handoff §3 (discard),
Addendum §A.9 (per-upload flag + per-user default) / §A.4 (org scoping), the
gap-audit findings 2.4 (write-only audit log) and 2.10/5.3 (env drift), and the
O1-C owner prompt. **Migration this session: 0016.**

## Ruling 1 — Discard mode follows the FROZEN handoff, not the prompt's paraphrase

The O1-C prompt describes discard as "delete the object after extraction and
record the mode on file_metadata." The **frozen** F1 handoff §3 (decision 0009
ruling 4) says the opposite and wins (standing rule: frozen handoff beats a
later paraphrase): discard keeps **no durable object and no `file_metadata`
row**. The object key is still minted and is still the `source_id` of every
derived memory.

Implemented exactly so: the bytes are staged at the key's staging twin
`{org}/{user}/staging/file-{uuid}` (the scope segment becomes `staging`),
carrying owner/scope/sensitive/upload-time in the object's metadata (there is no
row to read them from). The pipeline reads staging, derives memories with full
provenance to the byte-less source key, and deletes staging once those memories
commit. Deletion of a discarded source produces a receipt covering the memories
with `object_keys: []` — the saga already behaves this way (verified, not
modified).

## Ruling 2 — Staging cleanup is memory-safe (commit-then-delete), with a backstop

The handoff says "delete staging as the final step, inside the idempotency
transaction commit path." Taken literally (delete inside the memory tx), a
`COMMIT` failure after the delete would lose the extraction — unacceptable for a
*verifiable memory* product. So the pipeline **enqueues** the staging-delete job
in the same transaction as the memories (fires only on commit), rather than
deleting inline: the original is discarded only after its extraction is durable,
no memory-loss window. A **delayed backstop** cleanup enqueued at upload
(run_at +15 min) guarantees the staging bytes go even if extraction never
succeeds (corrupt file / crash); absent object = success. Staging keys never
enter `file_metadata`, provenance, or any receipt, so the sweep is blind to them
by construction. (This is a deliberate, safety-motivated realization of the
handoff's intent — flagged for owner awareness.)

## Ruling 3 — Discarded-source drawer + status by object key

A discarded file has no `file_metadata` and no object, so the source drawer
detects it via its derived memories (`MemoryStore.describeSource` — owner,
scope, sensitive, count) and shows "original discarded after extraction" with
download disabled and provenance + delete intact. The per-file **status** poll
authorizes by the object key (`{org}/{user}/…` encodes the owner), so it works
BEFORE any memory or metadata exists — a discard upload still shows
`processing` while extracting.

## Ruling 4 — Settings: only real, wired toggles (migration 0016 `user_settings`)

One row per user (`user_settings`: discard-by-default, default-scope), created
on first write; a read with no row returns the column defaults. The upload
endpoint applies these when a flag is omitted (server-side fallback, not just a
UI prefill), so `settings_defaults_applied` holds at the API. The instance
public key (F1) is shown read-only with an explanation — not duplicated, served
by the existing `/api/instance/public-key`. No aspirational toggles. Default
scope is functional for uploads now and feeds O2's shared-scope work; notes stay
private until then.

## Ruling 5 — The audit reader closes the write-only gap (migration 0016 `audit_log.org_id`)

`GET /api/audit` — reverse-chronological, filterable (actor/action/entityType/
date range), paginated, **read-only forever** (GET only; the append-only trigger
enforces immutability below the API). Org-scoped (§A.4): `org_id = caller.org OR
org_id IS NULL` — a caller sees their org's entries plus system/global ones,
never another org's. `audit_log.org_id` is additive + nullable (the freeze
trigger is untouched); `writeAudit` gained an optional `orgId`, populated on the
user-driven transitions (approvals, deletions, settings). Memory-status
transition audits remain null-org (system-visible) for now — threading org
through the `Memory` aggregate's actor is a follow-up.

## Ruling 6 — Hygiene

`.env.example` was already reconciled with code + compose in a prior session
(the audit's 2.10/5.3 `COGETO_MIGRATIONS_DIR`/`COGETO_PROMPTS_DIR` are present;
the MinIO SSE label is correct); an `env_consistency` spec now guards it in CI
(every read var documented in `.env.example` or compose; no dead entries).
Dead-code removal (listed): the Nav's disabled `UPCOMING` stub block (Settings
was its only entry — now a real, shipped section). No prompt history or eval
data touched.

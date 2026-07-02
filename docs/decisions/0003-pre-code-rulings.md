# 0003 — Pre-code rulings (Session 1)

**Date:** 2026-07-02 · **Status:** accepted · **Governs:** migration 0001 contents,
storage-access ownership, the `sensitive` flag, connector placement, container terminology
**Driven by:** the ambiguities recorded during onboarding; ruled by the owner in the
S1-A session prompt. Where a ruling conflicts with earlier wording in the Addendum,
AGENTS.md, or the glossary, **this record wins** and the targeted edits below were made.

## Ruling 1 — Migration 0001 contains the full contractual core

Migration 0001 creates the enums and the `memory`, `file_metadata`, `deletion_receipt`,
`approval`, and `audit_log` tables. Supporting tables (tasks, connector sync state,
prompt-registry entries beyond what S1-B needs) arrive with their features.

*Rationale:* the contractual schema (Addendum §A.6) is one reviewable unit; feature
tables have no contract to lock yet and would only churn the baseline.

## Ruling 2 — The memory module owns all storage access

The `memory` module owns the Postgres tables **and** the Qdrant client. Its public
interface exposes search primitives (vector, full-text, entity) that each **require a
`Principal` parameter** and apply the scope and sensitivity gates internally, so an
unscoped query is unrepresentable in the type system. The `retrieval` module composes
those primitives (fusion, status multipliers) and never touches a client or a table.

*Rationale:* one owner for every read path is what makes "no query path returns
memories without scope filtering" (AGENTS.md) enforceable by types instead of review.

## Ruling 3 — `sensitive` is an orthogonal boolean, not a status (Option A)

`sensitive` is a `BOOLEAN NOT NULL DEFAULT false` column on `memory` (mirroring
`file_metadata`), orthogonal to lifecycle. The `status` enum has **six lifecycle
values**: `active`, `outdated`, `contradicted`, `uncertain`, `replaced`,
`user_approved`. Retrieval rule: sensitive memories are excluded from default
retrieval, are returned **only to their owner**, and only on **explicit per-query
opt-in**. This supersedes the seven-state enum wording in the Addendum, AGENTS.md,
and the glossary; the targeted edits to AGENTS.md and the glossary were made in this
session.

*Rationale:* sensitivity is a property a memory keeps while its lifecycle moves
(a sensitive fact can become outdated); a single enum made those states mutually
exclusive by construction.

## Ruling 4 — Connector placement across app and worker

OAuth redirect/callback endpoints and webhook receivers live in the **app** process;
all periodic and incremental sync runs as **worker** jobs; tokens are encrypted at the
application layer immediately at callback and decrypted **only in the worker**.

*Rationale:* callbacks need a public HTTP surface but sync is slow-path work
(scope §6), and keeping decryption in the worker preserves the decider/actor
privilege separation (§A.8, research: agent-orchestration §7).

## Ruling 5 — Container-count terminology

The per-tenant stack is described as **"seven containers plus one-shot init jobs plus
an optional redaction profile"** (caddy, app, worker, postgres, qdrant, minio, zitadel).

*Rationale:* the Addendum ("~5"), the Technical Architecture ("six or seven"), and the
infra README ("~5") counted differently; one phrasing ends the drift.

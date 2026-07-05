# Session F1-B — the sweep, Forgotten, and the O1 handoff (§A.7 step 4, §B.1)

**Date:** 2026-07-04 · **Scope:** F1-B owner prompt. Completes Session F1;
design rulings in **decision 0009**; migration this session is **0010**;
the frozen O1 interface is **docs/handoff/F1-deletion-saga.md**.

## What shipped

### §1 The nightly sweep

- `IntegritySweep` (memory module): for every confirmed receipt, re-derives the
  enumerated identifiers from `counts_json` and verifies absence — no memory
  rows, no Qdrant points, no objects — and re-verifies the hash chain every
  run. Any hit → an `integrity_alert` row (migration 0010: receipt_id, kind,
  detail, detected_at; **deduped by unique expression index**, so re-detection
  is idempotent), surfaced in `/api/health` (`integrity` check → instance
  `degraded`), `/api/integrity`, the System view, and logged loudly. Alerts are
  never auto-repaired — a violated promise is evidence (0009 ruling 1).
- **Nightly:** graphile cron `0 3 * * * deletion_sweep` (underscore — the
  crontab parser rejects dots; caught live when the worker refused to boot).
  Deliberately not `idempotentTask`-wrapped (recurring; effects idempotent by
  dedupe) — the sanctioned exception is documented in code and 0009.
- **On demand:** `npm run sweep` locally, or against the stack:
  `docker compose exec worker node project/src/dist/entrypoints/sweep.js`
  (exit 1 on any alert / broken chain — scriptable as a probe).
- **Orphan drill (dev-only):** `npm run seed:orphan` /
  `docker compose --profile dev-seed run --rm seed-orphan` plants a stray
  Qdrant point matching a confirmed receipt. Excluded from the runtime image
  like seed-object.

### §2 The Forgotten section (nav enabled)

`/forgotten`: newest-first read-only ledger — source description, counts
(memories/vectors/files), requested + confirmed timestamps, status chip
(pending pulsing → confirmed; **alerting** in red when the sweep flagged it),
and the chain-verified badge from `/api/receipts/verify`. Pending receipts
poll every 3 s until confirmed. Receipt drawer: full canonical payload, hash,
prev_hash, signature, and **Export JSON** — the receipt plus the instance
public key and verification instructions, a self-contained artifact for a
client. UI copy states receipts are permanent and cannot be deleted; the empty
state explains a receipt in two sentences. Backing API: `GET /api/receipts`
(+ `/:id`), owner-scoped by the signed `requested_by` (0009 ruling 3).

### §3 System + health

System gains the **Deletion integrity** panel: last sweep time and result,
alert count (green zero / red with the alert table), live chain status.
`/api/health` gains the `integrity` check (open alerts + last sweep's chain
verdict; any alert degrades the instance). StatusPanel shows the new row.

### §4 Receipt permanence (new, DB-level)

Migration 0010 freeze trigger: DELETE on `deletion_receipt` never; UPDATE only
while `pending`. The `chain_integrity` test now disables the trigger to
simulate tampering — an attacker strong enough to do that is who the chain
catches.

## Tests — all green

| Test | Result |
|---|---|
| `sweep_clean` (confirmed receipts, clean stores → 0 alerts, chain ok, ledger entry written) | ✅ |
| `sweep_detects_orphan` (injected point → exactly one alert; re-run adds none; resolved drill sweeps clean) | ✅ |
| `receipts_immutable` (DELETE rejected, confirmed UPDATE rejected; no public mutation path) | ✅ |
| F1-A suite (cascade, atomicity, convergence, premature, chain, authz, cross-source, encryption) | ✅ 8/8 |
| receipt-chain unit suite | ✅ 10/10 |

Full battery: **build ✅ · lint ✅ · boundaries ✅ (179 modules, 0 violations) ·
tests ✅ 72 passed + 1 skipped · compose-to-login ✅.**

## Live verification (real stack, real login)

Performed against the running instance with a real admin session (scripted
PKCE login):

1. Captured a note → pipeline extracted 1 memory → `DELETE
   /api/sources/user_note/:id` → receipt pending → worker confirmed in seconds;
   `GET /api/receipts` shows it (the Forgotten ledger's data), `verify` returns
   `ok:true, verified:1`. **The first receipt on this instance is this drill.**
2. On-demand sweep: `1 receipt, 2 identifiers checked; 0 alerts; chain ok`.
3. Orphan drill: seed-orphan planted a stray point → sweep exit 1, exactly one
   `qdrant_point_present` alert → `/api/integrity` lists it, health went
   `degraded`, the receipt row showed `alerting` → removed the stray point and
   the alert row → sweep clean, health `ok`. The drill left no residue.

## Owner checklist

- [ ] Log in → Memories → capture a note → wait for processing → open the
      memory → Provenance → "Open source · delete…" → delete. Switch to
      **Forgotten** and watch the receipt go pending → confirmed (it polls).
      One receipt from my verification drill is already there.
- [ ] Open the receipt, check the payload/hash/signature, click **Export
      JSON**, and (optionally) verify the artifact independently against
      `GET /api/instance/public-key`.
- [ ] Orphan drill: `docker compose --profile dev-seed run --rm seed-orphan`,
      then `docker compose exec worker node project/src/dist/entrypoints/sweep.js`
      — watch System's Deletion integrity go red and health degrade. Resolve by
      deleting the stray point and the alert row (System shows both ids), then
      re-run the sweep to green.
- [ ] Confirm the nightly cron fires at 03:00 (worker logs `integrity sweep
      completed`), or just run the on-demand sweep periodically.
- [ ] Sign-off: decision 0009 rulings (sweep-detects-never-repairs, receipt
      permanence trigger, Forgotten owner-scoping, **extract-and-discard
      contract**) and the frozen handoff `docs/handoff/F1-deletion-saga.md`.

**Session F1 is complete.** Next: **F2 — reconcile + dreaming + gates**
(fresh Fable 5 session): real stage 6 (dedup, contradiction, supersession),
dreaming nightly cycle + digest, verification/v0003 (Croatian contrast),
dedup/contradiction golden cases, CI eval gate ON.

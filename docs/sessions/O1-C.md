# Session O1-C — Extract-and-discard, Settings, audit reader, hygiene

**Model:** Opus 4.8. **Implements against:** F1 handoff §3 (frozen discard),
Addendum §A.9/§A.4, gap-audit 2.4 (write-only audit) + 2.10/5.3 (env drift).
**Decision:** `docs/decisions/0016-discard-settings-audit.md`. **Migration:**
0016. **This completes Session O1** (files + approvals + audit + discard).

## What shipped

1. **Extract-and-discard** (per the FROZEN handoff, not the prompt's paraphrase
   — see decision 0016 ruling 1). Per-upload flag with a per-user default. No
   durable object, no `file_metadata` row: bytes are staged at the key's
   `staging/` twin, the pipeline derives memories with full provenance to the
   byte-less source key, and the staging object is deleted **after** those
   memories commit (memory-safe), with a delayed backstop for the failure path.
   Deleting a discarded source yields a receipt with `object_keys: []`. The
   drawer shows "original discarded after extraction", download disabled,
   provenance + delete intact.
2. **Settings** (`/api/settings`, migration 0016 `user_settings`): the
   extract-and-discard default and the default scope — the only two toggles,
   both wired (the upload endpoint applies them when a flag is omitted). Plus a
   read-only instance public key with an explanation.
3. **Audit reader** (`/api/audit`): reverse-chronological, filterable
   (actor/action/entity/date), paginated, org-scoped, **read-only forever**.
   Closes the write-only-audit gap (2.4). `audit_log.org_id` added (migration
   0016); user-driven audits (approvals, deletions, settings) carry it.
4. **UI**: a Settings page, an Audit page (both new nav items), a discard
   checkbox on the upload card (prefilled from settings), the discarded state in
   the source drawer, and a per-file status poll that works during processing.
5. **Hygiene**: an `env_consistency` spec guards `.env.example` ↔ code ↔ compose;
   removed the Nav's dead `UPCOMING` stub block (every section now ships).

## Test results (full battery)

- **build / lint / boundaries**: green (243 modules).
- **Vitest**: **134 passed, 1 skipped** (+8 this session; run
  `--no-file-parallelism`). New named tests:
  - `discard_mode` (connectors) — original never durable, staging deleted after
    extraction, memories retained with provenance, status pollable pre-memory,
    download disabled.
  - `settings_defaults_applied` (connectors) — an upload through the controller
    with no flags honors the saved discard + scope defaults.
  - `discard_receipt` (memory) — deleting a discarded source → receipt with
    `object_keys: []` and the correct memory count; chain verifies.
  - `audit_read_scoped` (entrypoints) — org scoping (never another org's),
    pagination without overlap, actor/action filters.
  - `env_consistency` (entrypoints) — every read env var documented; no dead
    `.env.example` entries.
- **`docker compose up` reaches login**: migration 0016 applied; app + worker +
  caddy rebuilt healthy; `/api/settings`, `/api/audit` routes mapped; worker
  registered `file.discard_cleanup`; `/login` 200; sweep clean (17 receipts,
  668 identifiers, 0 alerts, chain ok).

## Live drill (compose stack, real OIDC login)

- `PUT /api/settings {discardByDefault:true}` → saved.
- `POST /api/files` (a fact-bearing PDF, **no discard flag** → default applies)
  → `processing` immediately (status works before memories exist) → `done`.
- Drawer: `discarded: true`, `filename: null`; `GET …/download` → **404**.
- **2 memories retained** with object-key provenance; `…/impact` →
  `{memoryCount: 2, objectCount: 0}`.
- `DELETE …` → **200** + receipt (zero objects); the audit view shows the
  settings + deletion entries scoped to the caller's org.
- Instance left clean (0 file rows/objects); sweep clean.

## Audit view walkthrough

Open **Audit** (nav). A reverse-chronological timeline of every recorded action:
actor, action, entity type + a link where resolvable (a deletion → Forgotten, an
approval → Approvals, a memory → its drawer, a settings change → Settings), the
time, and the detail. Filter by actor, action, entity type, and a date range;
page with Newer/Older. It is read-only — there is no mutation path, and the
`audit_log` freeze trigger enforces that below the API.

## Discard demo (browser)

1. **Settings** → tick "Extract and discard by default" (or tick "Discard
   original after extraction" on a single upload). 2. **Memories** → upload a
   PDF/DOCX. 3. It processes; the original is deleted once its facts are
   extracted. 4. Open a derived memory → **Open source** → the drawer says
   "original discarded after extraction", download is gone, provenance + delete
   remain. Delete it → a signed receipt covering the memories, zero objects.

## Owner checklist (sign-off / decisions)

- [ ] **Discard follows the frozen handoff, not this prompt's paraphrase.** No
      `file_metadata` row / no durable object (staging + delete-after-commit).
      If you intended the paraphrase (keep a discarded-marked row), that is a
      handoff change needing sign-off — say so and I'll switch.
- [ ] **Migration 0016**: `user_settings` table + `audit_log.org_id` (additive,
      freeze trigger untouched). Confirm.
- [ ] **Audit org-tagging is partial**: approvals/deletions/settings carry
      `org_id`; memory-status transitions are still null-org (system-visible).
      Threading org through the Memory aggregate is a follow-up if you want every
      entry org-scoped.
- [ ] Numbering: decision **0016**, migration **0016** taken this session.

## STOP

**Session O1 is complete** — file upload + document pipeline (O1-A), the approval
state machine (O1-B), and extract-and-discard + Settings + the audit reader +
hygiene (O1-C). Next per the roadmap: **O2** (tasks UI, reminders, daily digest,
shared-scope + org second user, chat-derived memory capture, identity + gateway
seam tests).

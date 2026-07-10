# Session O3-A — The Ana sandbox (demo profile made real)

**Model:** Opus 4.8. **Implements:** the `--profile demo` sandbox (§B.9, scope
§8.4) — promoted from an S1 placeholder to the real growth engine that appears in
every pitch, launch post, and partner email. **Decision:** `0022` (Ana sandbox
rulings — frozen before code). **No migration** (the sandbox uses existing
tables; it seeds through the real public API).

## 1. Rulings (decision 0022)

Frozen before implementation:

- **Access model.** The demo-seed job provisions a **real Zitadel machine user**
  (the demo Principal, "Ana Kovač") and mints it a PAT — a real bearer token that
  resolves through the unchanged auth path (no bypass). The PAT is published on
  the (already public) `GET /api/config`; the SPA installs it on first load and
  skips login. **Single-tenant, disposable, no multi-visitor isolation** (v1);
  every visitor shares the one fictional world, restored by the periodic reset.
- **Security consequence, stated plainly** (in `docker-compose.yml` and
  `project/demo/README.md`): a demo instance publishes a working token to anyone.
  Acceptable ONLY because it holds no real data; it **must never share
  infrastructure with a customer instance**.
- **Mutability + reset.** Everything is mutable (capture, chat, correct, resolve,
  delete). `npm run demo:reset` tears down + re-seeds; a scheduled reset (worker
  cron, demo-only, default 6h) does the same. The Principal + token survive a
  reset, so an open tab keeps working.
- **Fictionality.** All data is fictional and authored for the sandbox,
  consistent with the golden-set persona. In the demo the visitor **is** Ana (the
  golden set's third-person notes, rewritten first-person).
- **Production guard.** `assertDemoAllowed` refuses the seed/reset when
  `COGETO_PRODUCTION=1` / `COGETO_ENV=production`, or without demo mode.

## 2. The persona corpus (`project/demo/`)

`seed/corpus.json` — **31 first-person notes** (26 en + 3 hr + 2 chat "remember
this"), plus the uploaded PDF. Authored terse and occasionally sloppy — not to
flatter the extractor. Each note carries a `daysAgo` so the seed back-dates it
(an UPDATE of `created_at`, never a fabricating INSERT) and the world reads as
weeks of accrual. Designed to produce, after **real pipeline processing**:

- **Identity** — Ana (consultant); clients Adriatic Foods (Atlas CRM Migration) +
  Baltic Retail; Marko/Luka (client contacts), Marta (subcontractor), Petra
  (colleague; Novira + Baltic kept distinct per canon).
- **The prominent Marko commitment with a condition** — "the revised Atlas
  proposal, once he confirms the Q3 budget" (answers "what did Ana promise
  Marko?" richly, with citations), enriched by a second mention.
- **A designed contradiction** — Atlas go-live recorded as September 1 **and**
  October 1, days apart, neither aware of the other → the Review contradicted
  queue, resolvable live.
- **Two lapsed facts** (staging access, early-bird — absolute past `valid_until`)
  → `outdated`; **a supersession chain** (invoice `racuni@` → `billing@` from June
  1) → `replaced` + history/time-travel.
- **Uncertain/hedged** — "Marko may prefer Teams over Zoom", a Croatian `navodno`
  office-move note, an undecided Baltic-leads thought → the uncertain queue.
- **Derived tasks** — one **blocked on a condition** (Marko/budget; HubSpot/export
  format), one **dormant** (an old vendor-register commitment, aged past the
  14-day silence window).
- **One uploaded document** — the *Adriatic Foods consulting agreement* PDF
  (`assets/`, regen via `build-agreement.mjs`) → several derived memories and
  **the deletion-receipt demo object**.

## 3. The seed mechanism (`project/src/entrypoints/demo/`)

A compose init job (`demo-seed`, profile `demo`, runs after the app is healthy):

1. `assertDemoAllowed` — refuse on a production instance.
2. **Provision** the demo Principal in Zitadel (idempotent machine user + PAT via
   the bootstrap PAT), publish its session to the shared `demo-config` volume.
3. **Feed the corpus through the REAL public HTTP API** — `POST /api/notes`,
   `POST /api/chat` + `…/remember`, `POST /api/files` — never a direct DB insert.
   Seeding the sandbox is therefore a continuous integration test of the system.
4. **Drain** the queue, **age** the world, run **one dreaming cycle** (drain
   again).
5. **Assert the end state** and **fail loudly** if the fictional world did not
   materialize (status counts, the contradiction pair, tasks incl. a blocked one,
   the document's memories, a Marko commitment). Idempotent: a re-run verifies
   rather than duplicating.

`resetDemoWorld` wipes (drain → delete objects → truncate every domain table
except the migration ledger + prompt registry → reindex-from-empty clears Qdrant)
then re-seeds. `demo:reset` runs it on demand; the worker schedules it (demo
only). The app auto-serves sandbox mode once the seed writes the session file, so
`docker compose --profile demo up` alone reaches a populated sandbox.

## 4. Sandbox UI

- **Permanent banner** (`DemoBanner`) — subtle, fixed, non-blocking: "Live
  sandbox · Ana Kovač · fictional data, resets periodically · Learn more →
  cogeto.eu". Sign-out is replaced by a "Live sandbox" tag.
- **First-visit overlay** (`DemoIntro`) — dismissible, never blocking (a click
  anywhere dismisses; remembered per browser). Three things to try, in order:
  ask what Ana promised Marko → resolve the contradiction → **delete Ana's
  contract and watch the receipt**.
- **Forgotten receipt** — already screenshot-ready (JSON export, chain badge);
  added **"Save as PDF"**, a clean single-page signed deletion certificate (the
  money screenshot). No signup prompts anywhere — one "Learn more" link.

## 5. Tests, gates

Named tests, all green:

- `demo_disabled_in_production`, `demo_pipeline_real` — fast, container-free
  (`entrypoints/demo/demo-guards.spec.ts`): the production flag refuses the seed;
  the seed path writes only through the public API (no memory inserts anywhere in
  it); the corpus is well-formed (≥25 notes, en+hr, a document).
- `demo_seed_asserts`, `demo_reset_idempotent` — Testcontainers pg+qdrant+minio
  (`entrypoints/demo/demo-seed.integration.spec.ts`): a pipeline-shaped world
  satisfies every hard assertion (and a broken world fails); the reset wipes
  Postgres + Qdrant + MinIO (preserving migrations + prompt registry) and a
  re-seed yields the identical asserted state.

The full HTTP-seed → extract → dream path (a real LLM) is exercised end-to-end by
`docker compose --profile demo up` (needs a Mistral key) — see the owner
checklist. Build, lint, dependency-boundaries all pass.

## The three demo moments (the pitch script)

1. **Ask what Ana promised Marko.** Chat → *"What did Ana promise Marko?"* → a
   cited answer: the revised Atlas migration proposal, conditional on Marko
   confirming the Q3 budget.
2. **Resolve the contradiction.** Review → the Atlas go-live is recorded as both
   September 1 and October 1 → pick the right one (or "correct both") and watch
   the memory settle.
3. **Delete Ana's contract, watch the receipt.** Forgotten → delete the *Adriatic
   Foods consulting agreement* → the deletion receipt confirms (hash-chained,
   signed) and exports as JSON or a printable PDF certificate. **This is the
   screenshot.**

## Reset command

```bash
npm run demo:reset          # tear down demo data + re-seed through the pipeline
```

## Assertion summary (what the seed guarantees)

`≥8 active memories · the go-live contradiction pair (relation + ≥2 contradicted)
· ≥1 outdated (lapsed) · ≥1 uncertain (hedged) · ≥3 derived tasks incl. ≥1
blocked-on-condition · ≥1 memory from the uploaded document · ≥1 Marko commitment`
(hard — the seed fails loudly otherwise). Soft/warned: a supersession chain
(`replaced`), a dormant task.

## Owner checklist

- [ ] **Launch the sandbox:** `docker compose --profile demo up --build` on
      **clean volumes**, with `COGETO_MISTRAL_API_KEY` set (the seed runs the real
      extraction/embedding pipeline). Add `COGETO_DEMO_MODE=1` to also enable the
      scheduled reset. Confirm the app reaches a populated sandbox and the SPA
      shows the banner + first-visit overlay with no login.
- [ ] **Verify the token flow.** The demo provisions a Zitadel **machine-user
      PAT** and expects it to resolve at the userinfo endpoint. If a future
      Zitadel change stops accepting PATs there, switch `zitadel-admin.ts` to a
      service-account JWT-profile grant (no caller changes) — flagged in 0022.
- [ ] **Deployment isolation (decision 0022 ruling 1).** The demo instance MUST
      run on its own Postgres/Qdrant/MinIO/Zitadel — never shared with a customer
      instance. A leaked demo token must reach nothing but fictional data.
- [ ] **Walk the three demo moments** and capture the deletion-receipt PDF — the
      screenshot for the pitch deck / launch post.
- [ ] **Confirm the scheduled reset** cadence (`COGETO_DEMO_RESET_CRON`, default
      6h) suits a hosted public demo.

## What O3-A deliberately did NOT do

- **Per-visitor sandboxes** (single shared fictional world in v1, decision 0022).
- The **Presidio redaction sidecar** and the broader **frontend design pass**
  (the rest of O3 — separate blocks).
- **Auto-capture** or any change to the pipeline/extractor — the sandbox
  demonstrates the existing system unchanged.

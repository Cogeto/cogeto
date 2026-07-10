# 0022 — Ana sandbox rulings (O3-A)

**Status:** Accepted (owner delegated the access-model call to this session —
"Recommended and to be confirmed by you"; confirmed here). **Context:** the
`--profile demo` compose profile has been a documented placeholder since S1
(`docker-compose.yml`, `demo-placeholder`). O3-A makes it real. The Ana sandbox
is not an internal fixture: it is the single artifact that appears in every
pitch, launch post, and partner email (§B.9, scope §8.4), so its rulings are
frozen here before code. The binding constraint is that the sandbox must
demonstrate the **actual system** — same endpoints, same pipeline, same
verifiable-memory guarantees — on **fictional** data, with **zero signup**.

## Rulings

### 1. Access model — a real, pre-authenticated demo Principal

A visitor uses the sandbox without signing up because the demo profile
**provisions a real Zitadel user** (the demo Principal, display name *Ana
Kovač*) at init and **grants its session on first visit**:

1. The **demo-seed init job** provisions, idempotently, a Zitadel machine user in
   the instance's single org (via the bootstrap PAT the `zitadel-init` job
   already mounts) and mints a **personal access token (PAT)** for it. The PAT is
   a real bearer token: it resolves through the unchanged `BearerAuthGuard` →
   `IdentityService.resolvePrincipal` → Zitadel userinfo path exactly like a
   human login. **No auth bypass is introduced.** The demo instance authenticates
   for real; it simply hands the visitor a pre-minted credential.
2. The PAT is written to a shared `demo-config` volume (`session.json`). The app
   serves it on the already-unauthenticated `GET /api/config` response
   (`WebConfig.demoSession`) whenever that file is present **and the instance is
   not production** — so `docker compose --profile demo up` flips the SPA into
   sandbox mode with no extra env (an explicit `COGETO_DEMO_MODE=1` forces it and
   also enables the worker's scheduled reset). A customer instance mounts an
   empty `demo-config` volume, so the file never exists and demo mode never
   activates. The SPA, seeing `demoMode`, installs that session on first load and
   skips the login screen.
3. **Single-tenant, disposable, no multi-visitor isolation (v1).** Every visitor
   shares the one demo Principal and the one org — consistent with decision 0019
   (cross-org isolation is the deployment boundary). Concurrent visitors see and
   mutate the same fictional world; the periodic reset (ruling 2) restores it.
   Per-visitor sandboxes are explicitly **not** built for v1.

**Security consequences (stated plainly, and warned in `docker-compose.yml` and
`project/demo/README.md`):**

- The demo instance publishes a working access token to anyone who loads the
  page. This is acceptable **only** because the instance holds **no real data**
  and is disposable.
- **The demo profile must NEVER share infrastructure (Postgres / Qdrant / MinIO /
  Zitadel) with a customer instance.** A leaked demo token must be able to reach
  nothing but fictional data. This is a deployment invariant, not a code check.
- The demo Principal is a low-privilege machine user with no project roles — it
  owns its fictional memories and nothing else.

### 2. Mutability and the reset story

Visitors may do everything a real user can: capture notes, chat and "remember
this", correct and re-scope memories, resolve the contradiction in Review, and
delete Ana's contract (the deletion-receipt moment). Nothing is read-only.

State is restored two ways:

- **`npm run demo:reset`** — tears down all demo data (Postgres domain tables,
  Qdrant points, MinIO objects) and re-seeds through the same pipeline. The demo
  Principal and its token are **preserved** across a reset, so an open browser
  tab keeps working.
- **Scheduled reset** — a Graphile-cron task (`demo_reset`), appended to the
  worker crontab **only when `COGETO_DEMO_MODE=1`**, default **every 6 hours**
  (`COGETO_DEMO_RESET_CRON`). It runs the identical wipe-and-reseed routine.
  Never scheduled on a non-demo instance.

### 3. Fictionality

All sandbox data is fictional and authored for the sandbox; it contains no real
person's data. **Ana Kovač, Marko, Marta, Luka, Petra, Adriatic Foods, Atlas CRM
(Migration), and Baltic Retail** are fictional and used consistently with the
golden set's persona (`project/eval/golden/`). Framing note: in the golden set
the note-taker refers to *Ana Kovač* in the third person as the Adriatic Foods
contact; in the sandbox the visitor **is** Ana (an independent consultant), so
the same corpus is written in the first person. Marko and Luka are her client
contacts at Adriatic Foods, Marta her subcontractor, Petra a colleague. Every
seeded document (the *Adriatic Foods consulting agreement* PDF) is authored for
the sandbox. The demo corpus lives under `project/demo/` and is **separate from
the golden set** — it is never scored by the eval harness and never changes CI
gate numbers.

### 4. The demo profile never boots on a customer instance

A startup assertion (`assertDemoAllowed`, shared by every demo entrypoint)
**refuses to run the demo seed or reset** when a production flag is set
(`COGETO_PRODUCTION=1` or `COGETO_ENV=production`) or when `COGETO_DEMO_MODE` is
not enabled. A production instance that somehow received the demo profile fails
loudly at boot rather than seeding fictional data into real infrastructure. This
is asserted by the `demo_disabled_in_production` test.

## Consequences

- Two new config flags (`COGETO_DEMO_MODE`, `COGETO_PRODUCTION`/`COGETO_ENV`) and
  a `WebConfig.demoMode` + `WebConfig.demoSession` extension. All default to the
  non-demo, non-production-asserting behavior, so existing instances are
  unaffected.
- The seed feeds the corpus **only through the public HTTP API** (`POST
  /api/notes`, `POST /api/chat` + remember, `POST /api/files`) — never direct
  memory-table inserts. This makes the seed a continuous integration test of the
  real system (`demo_pipeline_real`, `demo_seed_asserts`).
- The seed asserts its end state and **fails loudly** if the fictional world did
  not materialize as designed — a silently wrong sandbox is worse than none.
- Provisioning depends on Zitadel's PAT flow. If a future Zitadel change stops
  accepting PATs at the userinfo endpoint, the fallback is a service-account
  JWT-profile grant inside the same provisioning helper — no caller changes.
  (Noted in the O3-A owner checklist.)

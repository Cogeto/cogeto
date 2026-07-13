# Cogeto — Quality & Security Audit

**Date:** 2026-07-10 · **Scope:** the code that EXISTS at HEAD (not the planned
connector/productization backlog; see `implementation-gap-audit.md` for known gaps).
**Method:** read-only static review of every module, controller, migration, the
compose stack, CI, Dockerfiles, and the Python redaction sidecar; `npm audit`;
read-only git-history sweep. Six parallel adversarial passes (auth/authz, injection/
input, secrets/crypto, model-layer/DoS/deps, privacy/deletion, quality/correctness),
each finding carrying `file:line` evidence, cross-checked by hand on the load-bearing
items. No files were modified except this report.

## Executive summary

The core is **honestly built and the crown-jewel scope gate holds**: no endpoint
derives owner/org from the request body or query, every read composes the
`owner_id = caller OR scope='shared'` gate in SQL and as a non-optional Qdrant payload
pre-filter, an unscoped read is not constructible through any public interface, the
receipt hash chain verifies signatures correctly, redaction genuinely fails closed
(non-mocked test, embeddings included), and there is no model-gateway bypass (CI-enforced).
But the product thesis — *verifiable memory you can trust* — is refuted in three places.
**Counts: CRITICAL 0 · HIGH 6 · MEDIUM 12 · LOW 21 · INFO 3.**
The three findings that most threaten the thesis: **QS-1** — the model's one-sentence
"reason" text (naming values from *private* memories) is written to the org-wide,
append-only `audit_log` and is readable by every other org member and survives deletion;
**QS-5** — a source deleted while its ingestion job is mid-flight resurrects memories from
the "erased" source into no receipt (provable forgetting broken); **QS-4** — the default
Caddy edge proxies unauthenticated Qdrant/MinIO consoles by Host header, so the whole
memory store is exposed if the stack is deployed on a reachable host.
**Not audited (honest limits):** no dynamic/pen-test run, the app was never booted, the
Vitest suite was not executed, the OIDC flow was reasoned from code not exercised
live, the upload parsers were not fuzzed, `pip-audit` was not run on the sidecar (no
venv), and QS-5's race was proven by code path, not reproduced.

---

## Findings (security first, then quality; ordered by severity)

### Security — HIGH

| ID | Evidence | Scenario | Fix scope |
|---|---|---|---|
| **QS-1** | `reconciliation.ts:286` (`memory.contradiction_detected` detail `{a,b,reason}`), `memory.store.ts:301` (status_transition detail), `tasks.engine.ts:336,366`, `reconciliation.ts:230` (`memory.merged`); prompt requires naming the incompatible slot (`prompts/reconcile_contradiction/v0001.md:31`); reader `audit.controller.ts:52,78` returns `detail` org-wide; append-only trigger `0001…sql:100`. | User B opens `/api/audit` and reads a model sentence paraphrasing user A's **private** memory ("Fact A says €48,000, Fact B says €52,000"); the memories are later deleted, the sentence is not. Directly contradicts decision 0020 ruling 6's "no detail field contains content." | Stop persisting model `reason` in audit detail (keep on owner-scoped surface / relation row), or stamp `owner_id` and owner-filter detail visibility. **RESOLVED (2026-07-10, session FIX-1, decision 0025):** BOTH halves done — no writer persists model free-text in detail anymore (contradiction reason moved to the owner-gated `memory_relation.reason`, migration 0020; merge/supersession/closure rationales deliberately not persisted); `audit_log.owner_id` added and the reader returns `detail_json` only to the stamped owner (`detailWithheld` otherwise); migration 0020 scrubs the `reason` key from all pre-existing rows (trigger-sanctioned, itself audited as `audit.detail_scrubbed`). Cross-user test `detail_owner_gated` + scrub-replay test in audit.integration.spec. |
| **QS-2** | No `@nestjs/throttler`/rate-limit anywhere (grep clean); `app.ts:12-19` registers no limiter; model endpoints `chat.controller.ts:76` (~3 Mistral calls), `.../remember`, `files.controller.ts:61`, `notes.controller.ts` — all `BearerAuthGuard` only. | Any authenticated caller loops `POST /api/chat` at wire speed and drains the Mistral budget; **worst on the public demo**, which publishes a real bearer token on `/api/config` — any anonymous visitor drains the account. | Add per-principal throttling on chat/capture/upload + a daily per-user model-call/token budget in the gateway; aggressive caps when `demoMode`. **RESOLVED (2026-07-13, session FIX-2):** in-process per-principal `RateLimitGuard` (`@RateLimit`) on chat/capture/remember/upload + a per-user daily model call/token budget enforced in a gateway decorator (`BudgetedModelGateway`, attributed via a per-request AsyncLocalStorage user scope; unattributed worker calls unmetered). Chat over-budget → distinct SSE error event; other paths → 429 (`ModelBudgetExceptionFilter`). demoMode auto-tightens every limit (own `COGETO_DEMO_*` namespace). All env-configurable (see .env.example). Tests: abuse-control.spec, budgeted.gateway.spec. |
| **QS-3** | `web-config.controller.ts:37-40` serves `demoSession.accessToken` whenever a `session.json` exists in `demo-config` (file-presence flips demo mode); only `config.production` suppresses it, and `production` is opt-in defaulting false (`config.ts:71,148`); every instance mounts `demo-config:/demo-config:ro` (`docker-compose.yml:89`). | A customer instance that omits `COGETO_PRODUCTION=1` and has any stray `session.json` in a reused `demo-config` volume hands a working bearer token to any anonymous caller of `/api/config`. Fail-open by default. | Require explicit `demoMode` (not file-presence) to serve the session, or default `production` true unless demo is explicitly enabled. **RESOLVED (2026-07-13, session FIX-2):** `/api/config` serves the demo session ONLY with explicit `COGETO_DEMO_MODE=1` (`production || !demoMode` → base config); a stray `session.json` never flips it. The app logs its effective mode at boot. The demo compose profile now requires `COGETO_DEMO_MODE=1`. Test: web-config.spec (fail-closed). |
| **QS-4** | `caddy/Caddyfile:41-53` — vhosts `s3.localhost`, `minio.localhost`, `qdrant.localhost` reverse-proxy to internal services with **no auth**; Caddy routes by Host header; ports 80/443 published (`docker-compose.yml:15-17`). Only a comment guards it (`Caddyfile:37`). | On any publicly reachable host running the default Caddyfile, `curl -k https://<ip> -H 'Host: qdrant.localhost'` (SNI matching) gives unauthenticated Qdrant read/write over **all** memory embeddings + payloads (owner_id/scope), plus the MinIO console. | Gate the console vhosts behind a profile or bind them to a localhost-only listener; add a Qdrant API key. **RESOLVED (2026-07-13, session FIX-2):** the s3/minio/qdrant vhosts moved out of the public Caddyfile into `Caddyfile.consoles`, served by a `caddy-consoles` service under the `consoles` compose profile bound to `127.0.0.1` only; the default deployment exposes exactly the app vhost. Qdrant gets `QDRANT__SERVICE__API_KEY` (from `COGETO_QDRANT_API_KEY`), threaded through every Qdrant client. Test: deployment-hardening.spec. |
| **QS-5** | `pipeline.service.ts:96,52-53` (tx held open across model calls), `notes.source-reader.ts:19-20` (`load()` on `this.db`, **no lock**), `deletion-saga.ts:195-223` (enumerates+deletes before nothing serializes the reader), `memory.source_id` is `text NOT NULL` with **no FK** (`0001…sql:31,46`); sweep only checks receipt ids (`integrity-sweep.ts:83`). | User deletes a note while its pipeline job is mid-extraction (5–30 s window): the saga enumerates zero memories, confirms the receipt, then the pipeline commits fresh memory rows + Qdrant points whose provenance points at the deleted note — in no receipt, invisible to the sweep. **Provable forgetting broken.** | In `requestSourceDeletion`, after locking the source, claim/cancel the pending `(source_type, source_id, ingestion.pipeline)` idempotency key so the job no-ops; re-verify source existence inside the pipeline tx before admitting. **RESOLVED (2026-07-10, session QS-B, decision 0024):** both sides implemented — the saga cancels pending ingestion via the new `IngestionGuard` port (`consumeIdempotencyKey` under an advisory run-lock probe; waits out in-flight runs for discard-mode files), AND the pipeline re-verifies source existence with a `FOR KEY SHARE` lock inside its admission transaction (`SourceReader.existsForAdmission`), aborting as an audited no-op when the source is gone; the nightly sweep gained an orphan-memory arm (receipt-side + source-side detectors). Race proven by test `deletion-race.integration.spec.ts` (fails red without the fix — resurrected row; green with it). |
| **QS-6** | `document-extract.ts:54-75` — `pdf-parse`/`mammoth.extractRawText` on the full buffer with **no page/output/time cap**; `chunk.ts:15` no max-chunk count; extraction facts array has **no `.max()`** (`candidate-fact.ts:78`); 1 extract/chunk + 1 verify/fact + ~6 reconcile/fact + embed. 25 MB upload cap bounds only *compressed* input. | A 25 MB zip-bomb `.docx` decompresses to GBs of text and OOM-kills the worker (concurrency 2 → all ingestion down); or a large-text doc yields thousands of Mistral calls and memory rows per upload, with no per-user upload cap. | Cap decompressed-text length + chunk count in the pipeline, add `.max()` to the facts array, add a wall-clock timeout around parse, and a per-user daily upload/capture cap. **RESOLVED (2026-07-13, session FIX-2):** `document-extract` caps decompressed text length + a wall-clock parse timeout (over-cap → `PermanentExtractionError`, zero model calls); the pipeline caps chunk count and total facts per source; `extractionOutputSchema.facts` gained `.max()`; per-user daily capture/upload caps in NotesService/FilesService (429 over cap). All env-configurable. Tests: document-extract-caps.spec, candidate-fact.spec, pipeline parse_caps, notes daily_capture_cap. |

### Security — MEDIUM

| ID | Evidence | Scenario | Fix scope |
|---|---|---|---|
| **QS-7** | `chat.service.ts:257-260` stores the full synthesized answer (quoting retrieved facts) as a `chat_message` row; the saga deletes only the source turn (`chat.source-deletion.ts`). | User deletes the note behind "fee is €48,000"; every past chat answer reciting it stays readable in their chat history. Owner-scoped (not cross-user), but the receipt proves less than it claims. | A DerivedCascade over `chat_message` rows citing deleted memory ids (citation→memory linkage exists at write time), or document the boundary in the receipt/UI. **RESOLVED (2026-07-10, session FIX-1, decision 0025):** the cascade option — `ChatAnswerCascade` (DerivedCascade) redacts every assistant message whose stored `{{cite:<id>}}` tokens reference erased memories (historical answers and peers' answers citing a shared fact included) to a timeline-preserving deletion marker, counted additively in `counts_json.chat_messages_redacted` and shown in the Forgotten ledger. Idempotent (redaction removes the tokens). Tests: chat-answer-cascade.integration.spec (cascade + idempotency + cross-owner + receipt count). |
| **QS-8** | Committed default KMS key `docker-compose.yml:273` (`cogeto-dev-key:bxa…`); dev passwords `:42,232,259,285,291,303` (`cogeto-dev-password`, `MasterkeyNeedsToHave32Characters`, `DevPassword1!`); nothing fails closed on the known value. | An operator who deploys without overriding ships known admin creds and a **known SSE-S3 master key** — at-rest encryption is decorative against stolen-disk + public-repo. | Refuse boot (or `minio-init` assert) when a secret equals the known dev value and the host is not `localhost`. **RESOLVED (2026-07-13, session FIX-2):** a `preflight` init container (handed every secret) refuses to boot when any known committed dev value guards a non-localhost deployment (`COGETO_EXTERNAL_DOMAIN` not localhost); app/worker/zitadel/migrate depend on it. `loadConfig` re-checks the app-visible subset. Test: secret-preflight.spec. |
| **QS-9** | `docker-compose.yml:86` mounts the whole `instance-keys` volume (private key included) into the internet-facing `app`, which only ever needs the public half (`receipts.controller.ts:69`, `integrity-sweep.ts:105`). | Any RCE/path-traversal in the HTTP-facing app exfiltrates the receipt-signing private key → forged "provably deleted" receipts. | Mount only `instance-signing-key.pub.pem` into `app`; the worker keeps both. **RESOLVED (2026-07-13, session FIX-2):** migrate publishes the public half into a separate `instance-pubkey` volume; the app mounts that public-key-only volume and asserts at boot the private key is unreachable (`assertAppKeyMount`, `COGETO_ASSERT_NO_PRIVATE_KEY=1`); the worker keeps the full pair. The receipts controller already read the public half only. Tests: deployment-hardening.spec (mounts + guard). |
| **QS-10** | `jobs.controller.ts:40,120,141` — `activity`/`dead-letter`/`retry` carry only `BearerAuthGuard`, no org/owner filter; payloads expose `source_id`/object keys (embedding org/user ids) for all users; `retry` re-enqueues any parked job. | An authenticated low-privilege user enumerates other users' object keys + memory ids via `/api/jobs/activity` and replays their jobs via `/dead-letter/:id/retry`. | Org/owner-scope the jobs reads; restrict to an admin role. |
| **QS-11** | `identity.service.ts:34-35,59-61` caches the resolved Principal keyed by raw token for `cacheTtlSeconds` (=60, `app-root.module.ts:32`); userinfo is not re-consulted within the window. | A token revoked at Zitadel (logout, compromise) keeps authenticating every request for up to 60 s. | Lower the TTL, add a revocation check, or accept as a documented window. |
| **QS-12** | `multer@2.1.1` (`npm audit`: GHSA-72gw-mp4g-v24j, GHSA-3p4h-7m6x-2hcm, High) is used by `document-upload.interceptor.ts:21` on `POST /api/files`. | The aborted-upload-cleanup DoS applies directly to the upload path; nested-field-name DoS on multipart parsing. | `npm audit fix` (non-breaking) to patch multer. **RESOLVED (2026-07-13, session FIX-2):** multer pinned to the patched `2.2.0` line (root `overrides` + direct dep on `@cogeto/server`; @nestjs/platform-express deduped to 11.1.28). `npm audit` now reports 0 multer advisories. |
| **QS-13** | `grep -c orgId` = 0 in `memory.store.ts`, `reconciliation.ts`, `tasks.engine.ts`, `dreaming.service.ts` — their rows are NULL-org and reach every org's reader via the `IS NULL` arm (`audit.controller.ts:52`); flagged in decision 0020:54. | Amplifies QS-1: NULL-org detail rows are visible to the whole instance's readers. | Stamp `org_id` on every audit writer (mechanical). **RESOLVED (2026-07-10, session FIX-1, decision 0025):** every owner-concerning writer now stamps `owner_id` always and `org_id` from the Principal where present, else via the identity directory (`UserDirectory.orgOf`, memoized, injected into memory store / reconciliation / tasks engine). Genuine system entries (sweep, dreaming summary, chain confirmations) stay NULL-org by design — their detail is instance-level counts, and the new owner-gate makes the `IS NULL` arm carry structural metadata only. |
| **QS-14** | `chat.controller.ts:76-104` opens `text/event-stream` for the whole generation; no per-principal concurrent-stream cap, no idle timeout. | One caller opens hundreds of concurrent `POST /api/chat` streams, each pinning a Node handler + upstream Mistral stream — sockets/event-loop + budget exhausted together. | Cap concurrent SSE streams per principal; set max-duration/idle abort. **RESOLVED (2026-07-13, session FIX-2):** the chat controller caps concurrent SSE streams per principal (429 before the stream starts) and races each generator step against an idle timeout + hard max-duration `AbortController` (abort → `timeout` SSE error event, slot released). Env-configurable. Test: chat-sse-limits.spec. |
| **QS-15** | `.github/workflows/eval-gate.yml:16` triggers on `pull_request` (not `pull_request_target`) and runs `npm run eval` with `secrets.MISTRAL_API_KEY`; trigger paths include editable `project/eval/**`, `project/src/ingestion/**`. Fork PRs correctly skip (secret absent). | A **same-repo** PR (a collaborator/bot branch) edits the eval harness to print/POST `$MISTRAL_API_KEY` and CI hands it the live key. HIGH if the repo has non-owner collaborators; LOW if single-owner. | Run live-key eval only on `push`/`workflow_run` post-merge or behind a manual-approval environment. |
| **QS-16** | `memory.store.ts:305,387,419,595`, `reconciliation.ts:109,499` write Qdrant payload last in the PG tx; if the **COMMIT** fails after `setPayload`, Qdrant leads PG; the sweep never checks live-row payload consistency; `reindexMemories` is manual/demo-only (`entrypoints/reindex.ts`). | A `shared→private` demote whose payload write lands but commit fails leaves stale Qdrant payload indefinitely (retrieval re-gates through PG so no leak, but recall/topK silently distorted). | Add a payload-consistency arm to the nightly sweep, or schedule periodic reindex. **RESOLVED (2026-07-10, session FIX-1, decision 0025):** nightly `payload_mismatch` sweep arm — FULL scan (keyset pages of 500; cost justified in 0025) of embedded live rows' `owner_id/scope/status/sensitive` vs the Qdrant payload; mismatches alert AND self-heal by idempotent targeted `setPayload`; missing points alert for `reindex`. Alert copy states the honest severity ("recall/consistency only, not a leak — retrieval re-gates through Postgres"). Test `payload_mismatch_arm` (flag + heal + idempotent re-run) in sweep-arms.integration.spec. |

### Security — LOW

| ID | Evidence | Scenario / note | Fix scope |
|---|---|---|---|
| **QS-17** | `identity.service.ts:37-44` treats userinfo `200` as full proof; no local `iss`/`aud`/`exp` check (userinfo does not enforce audience). | On a shared Zitadel a token minted for a different client would still resolve. | Validate `aud` against the SPA client id, or move to JWKS behind the same seam. |
| **QS-18** | No `APP_GUARD`/`useGlobalGuards`; every controller must remember `@UseGuards(BearerAuthGuard)` (all do today). | A future controller that forgets the guard is silently public (fail-open). | Register the guard globally + `@Public()` on `health`/`config`/`instance`. |
| **QS-19** | `web/src/auth/oidc.ts:106` stores access/id tokens in `sessionStorage`; sent as `Authorization: Bearer` (`api.ts`). CSRF is not a concern (no cookie session). | Any XSS reads `sessionStorage` and exfiltrates a live token. Standard SPA tradeoff. | Strict CSP / token-handler pattern; keep third-party script surface at zero. |
| **QS-20** | `audit.controller.ts:54` `ilike(actor, '%'+q.actor+'%')` — value is bound (no SQLi) but `%`/`_` act as LIKE metacharacters. | An authenticated user passes `%` to match everything / craft slow leading-wildcard patterns on the audit query. | Escape `%`/`_`/`\` (bound ESCAPE clause) in the filter. |
| **QS-21** | `docker-compose.yml:79-83,419` — the `redaction` profile brings the sidecar up, but the gateway redacts only if `REDACTION_ENABLED` is truthy (`config.ts:12`). | `docker compose --profile redaction up` without the env var = sidecar running, **plaintext flowing** — looks enabled, isn't. | Log the effective redaction state loudly at boot, or refuse profile-without-env. |
| **QS-22** | `logger.ts:14` redact paths are pino depth-1 (`*.content`); `worker.ts:160`/`app.ts:23` top-level `console.error(err)` can print `ModelGatewayError` messages embedding Zod "received value" fragments of model output (`mistral.gateway.ts:113`); `dead_letter.error` column likewise. | A nested `logger.error({err})` or a corrective-retry error lands model-output fragments (plaintext when redaction off) in logs. | Deepen redact paths + a serializer; log `error.message`/class only at top level. |
| **QS-23** | `0010_integrity_sweep.sql:28` freeze trigger; `receipt-chain.ts:82` accepts any complete prefix (empty chain ok). | A DB superuser who drops the trigger and deletes the newest N confirmed receipts leaves a shorter chain that still verifies `ok`. Tail truncation is undetectable. | Externally anchor the tip hash / receipt count (e.g. include tip in user-downloadable receipts). |
| **QS-24** | `docker-compose.yml:285` `command: 'start-from-init --masterkey "${ZITADEL_MASTERKEY…}"'`. | The Zitadel masterkey is visible via `docker inspect` / in-container `ps`. | Use Zitadel's env/file masterkey option. **RESOLVED (2026-07-13, session FIX-2):** Zitadel now starts with `--masterkeyFromEnv` reading `ZITADEL_MASTERKEY` from the environment — the key is off the command line (no longer visible via `docker inspect`/`ps`). Test: deployment-hardening.spec. |
| **QS-25** | Base images on floating tags (`node:22-alpine`, `minio/minio:latest`, `minio/mc:latest`, `busybox:stable`, `caddy:2-alpine`); spaCy `en_core_web_lg` fetched unpinned (`redaction/Dockerfile:17`). | Non-reproducible builds; silent MinIO drift; unpinned model download is a supply-chain gap. | Pin by digest/concrete version; pin the spaCy model artifact. **RESOLVED (2026-07-13, session FIX-2):** every base image (node, caddy, postgres, qdrant, minio, mc, busybox, zitadel, python) pinned by digest in the Dockerfiles + compose; the spaCy `en_core_web_lg-3.7.1` model pinned to an exact wheel URL (no `spacy download`). Update procedure: docs/operations/image-pins.md. Test: deployment-hardening.spec (every `image:` is a digest). |
| **QS-26** | `memory.store.ts:305` `this.vectors?.setPayload` in `transitionInTx`/`supersedeCore` vs `:387,419` `requireVectors()` in toggles; `factory.ts:28` builds vector-less stores. | A `MemoryStore` wired without Qdrant runs supersession/contradiction transitions whose points still say `active` in Qdrant — no error, no log — distorting reconciliation candidate pre-filters. | Make transition paths use `requireVectors()` like the toggles, or add a boot assertion. **RESOLVED (2026-07-10, session QS-B):** `transitionInTx` and `supersedeCore` now use `requireVectors()` exactly like the toggles; `MemoryModule.register` boot-asserts `qdrantUrl`; the factory's vector-less form now requires an explicit `sqlOnly: true` marker reserved for test/fixture paths that exercise no transition. Regression test `vectorless_transition_throws` (memory.integration.spec.ts) asserts a transition/supersession on a vector-less store throws instead of silently skipping. |
| **QS-27** | `memory.store.ts:334-355` → `transitionInTx:305`: `bulkMarkOutdatedForOwner` runs up to 500 sequential Qdrant HTTP calls inside one PG tx holding 500 row locks. | A Qdrant hiccup mid-loop rolls back everything and holds 500 locks for `timeout × N`. | Batch the Qdrant updates / move them outside the row-lock window. **RESOLVED (2026-07-13, session FIX-2):** `bulkMarkOutdatedForOwner` now transitions PG-only (`transitionInTx({syncPayload:false})`) and returns the changed ids; the Qdrant payload sync runs AFTER commit via an `afterCommit` continuation threaded through `idempotentTask` (best-effort; the payload-consistency sweep is the backstop). No row lock is held across the Qdrant HTTP calls. Test: approvals `bulk_outdate_syncs_qdrant_after_commit`. |
| **QS-28** | `connectors/files.service.ts:145,219` `deleteObject(...).catch(()=>undefined)`; the integrity sweep only checks receipt keys — no orphan-object sweep. | If the metadata tx fails AND the compensating delete fails (or a crash between PUT and tx), orphan PII bytes persist in MinIO forever, in no receipt. | Add an orphan-object sweep (objects with no `file_metadata`); alert. **RESOLVED (2026-07-10, session FIX-1, decision 0025):** nightly `orphaned_object` sweep arm (full `ListObjectsV2` scan; 60-min grace window covers mid-upload PUTs and the staging backstop; stale staging objects flagged too; detection only — deletion stays the saga's monopoly); the upload path's compensating deletes are now retried with backoff and logged instead of `.catch(()=>undefined)`. Injection-fixture test `orphan_object_arm` in sweep-arms.integration.spec. |

### Quality — MEDIUM

| ID | Evidence | Scenario | Fix scope |
|---|---|---|---|
| **QS-29** | `temporal-resolver.ts:130-135` weekday lead-in `(?:by\|before\|on\|this\|next\|coming\|the)?` omits `last`; `nextWeekday:80` always resolves forward; chrono never reached (:109); no "last"/"ago" test cases. | "met Sarah last Monday" gets `valid_from` **7 days in the future**; point-in-time/staleness reasoning runs over a fact that "starts" after it was observed. | Handle `last\|past` lead-ins (resolve backward / fall through to chrono) + golden cases. |
| **QS-30** | `approvals.integration.spec.ts:42` builds `MemoryStore` with no vectors → the approved bulk-outdate's Qdrant propagation is unverified; every "double" case is sequential (:171-194) — no concurrent confirm/execute test exists. | The exactly-once approval guarantee (row locks + idempotency key) looks correct but a check-then-act regression would not be caught; the vector arm of the gate is untested in the approval suite. | Add the Qdrant arm to the approval suite + a genuine concurrent confirm/execute test. |

### Quality — LOW / INFO

| ID | Sev | Evidence | Note |
|---|---|---|---|
| **QS-31** | LOW | `memory.store.ts:823-834` — `changesSince` scans audit rows **globally** (all owners) with `limit*2`, then filters to visible. | On a busy multi-user instance another owner's events push the caller's out of the window → silently missing from "what changed since". Fix: filter on ownership before the limit. |
| **QS-32** | LOW | `temporal-resolver.ts:113-115,63` — "today/tomorrow" resolve against UTC midnight of `created_at`. | A CET user capturing at 00:30 local sees "tomorrow" resolve to their today — user-visible off-by-one near midnight for the EU audience. Fix: thread instance timezone into the anchor. |
| **QS-33** | LOW | `entrypoints/demo/reset.ts:34-72` + `worker.ts:102-117` — no advisory lock; manual and scheduled resets can interleave; captures after `waitForQuiescence` survive truncation. | Demo-only; self-heals next cycle. Fix: `pg_advisory_lock` around reset. |
| **QS-34** | LOW | `queue.ts:54-58` — the `dead_letter` insert on the final attempt can itself fail; graphile marks the job failed with no dead-letter row; `health.controller.ts:77` then shows green. | Lost work invisible to health. Fix: make dead-letter write robust / alert on graphile permanent failures. |
| **QS-35** | LOW | `health.controller.ts:32-48` checks PG/Qdrant/MinIO/encryption/migrations/integrity/queue but **not** Mistral/model-gateway reachability. | The instance reports green while chat + ingestion are fully down. Fix: add a gateway reachability check. |
| **QS-36** | LOW | `web/src/App.tsx:27-39` web-config `staleTime: Infinity`, never invalidated; `MemoryDrawer.tsx:167-173` nuclear `invalidateQueries()` blocks the drawer until all queries settle; `CitationChip.tsx:29` 30 s stale, no poll. | A rotated demo token strands the SPA with a dead bearer until hard reload; refetch storm; a chip shows a fact trustworthy briefly after a background contradiction. Fix: targeted invalidation + re-fetch web-config on 401. |
| **QS-37** | LOW | `memory.source_id` is `text NOT NULL` with only an index, no FK (`0001…sql:31,46`). | AGENTS.md "no orphans, ever" is a convention, not a DB constraint — enables QS-5's orphan rows. Fix: enforce provenance integrity (app-level check or per-source FK). **RESOLVED (2026-07-10, session QS-B, decision 0024):** enforcement is the mandatory app-level admission checkpoint (`existsForAdmission`, KEY SHARE in the admitting tx) + saga-side idempotency-key cancellation, with the nightly sweep's `orphaned_memory` arm as the detector (receipt-side resurrection check covering all source types incl. discard files, plus source-row existence probes through the SourceDeletion adapters — historical residue included). Per-type FKs and an insert trigger were evaluated and rejected in 0024 (polymorphic provenance + discard-mode sources make both unsound); the bar "impossible or detected within one sweep cycle" is met via detection, without touching the saga's delete ordering. Tested by `orphan_sweep_arm` (deletion-race.integration.spec.ts). |
| **QS-38** | LOW | `database.module.ts:28`, `worker.ts:49` — `new Pool({connectionString})` with no `max` (node-pg default 10); pipeline holds a tx across model calls (`pipeline.service.ts:52`); PG shared with Zitadel. | Not a today-break (concurrency 2 ≤ 10) but unpinned under load. Fix: set explicit `max` on both pools; reconsider holding the tx across model calls. |
| **QS-39** | INFO | `integrity-sweep.ts:30` / `dreaming.service.ts:41` crons at `0 3`/`30 3`/`40 3` rely on wall-clock ordering with concurrency 2; 03:00 sits in the EU DST window. | A >30-min sweep overlaps the dream cycle; DST double-fire/skip once a year. Fix: single-flight lock + UTC crons. |
| **QS-40** | INFO | dependency-cruiser can't catch raw-SQL cross-module table access (`entrypoints/demo/ops.ts:94`, `health.controller.ts:76` query domain tables) or a domain module opening its own `pg` Pool. | The §A.1 "no cross-module table access" guarantee rests on convention in those spots. Fix: add a forbidden rule confining `node_modules/pg`; keep raw-SQL to composition roots. |
| **QS-41** | INFO | `reconciliation.ts:353-454` (`resolveContradiction`, ~100 lines, 3-way branch), `reconcile.stage.ts` (375-line file), `memory.store.ts:805-877` (`changesSince`). | Densest cognitive-load spots; well-commented but at the edge. Fix: extract outcome helpers when next touched. |

---

## Endpoint authorization table (§1.2)

Auth is **per-controller** `@UseGuards(BearerAuthGuard)` — no global `APP_GUARD` (QS-18).

| Route(s) | Guard | Owner/org derivation | Verdict |
|---|---|---|---|
| `notes.*`, `files.*`, `settings.*` | Bearer | Principal → service owner check | OK |
| `tasks.*` | Bearer | `principal.userId` in engine (`tasks.engine.ts:522,568`) | OK |
| `memories.*` (list/get/chain/approve/reject/edit/scope/sensitive) | Bearer | `MemoryStore` gates + `lockRow` owner check (`:1090`) | OK |
| `memories/:id/verification`, `dreaming/latest` | Bearer | resolved via gated `getForPrincipal`/`getMany` first | OK |
| `receipts.*` | Bearer | `counts_json->>'requested_by' = userId` (`receipts.controller.ts:80`) | OK |
| `integrity`, `receipts/verify` | Bearer | instance-wide by design (decision 0009) | OK (INFO) |
| `sources/:type/:id` (delete) | Bearer | saga `loadAndAuthorize` owner check (`deletion-saga.ts:318`) | OK |
| `relations.*` | Bearer | both facts owner-checked (`reconciliation.ts:335,371`) | OK |
| `approvals.*` | Bearer | org-scoped `lockForOrg` (`approval.service.ts:184`) | OK |
| `chat.*` | Bearer | `eq(chatMessage.ownerId, userId)` | OK |
| `audit` | Bearer | org-gated `orgId = caller OR IS NULL` (`audit.controller.ts:52`) | OK but leaks content — **QS-1/QS-13** |
| `jobs.*` (activity/dead-letter/retry) | Bearer | **no org/owner filter** | **QS-10** |
| `me` | Bearer | returns own Principal | OK |
| `health`, `health/live`, `instance/public-key` | none | — | Intentional |
| `config` | none | serves demo token by file-presence | **QS-3** |

No endpoint derives owner/org from body or query (no CRITICAL). IDOR sweep clean:
every `:id` route re-derives identity from the Principal and 404s foreign rows.

## Deletion-completeness table (§1.8)

Saga: `deletion-saga.ts`; executor `:336-405`. Rows/points/bytes are airtight; the
gaps are model-generated **derivatives**.

| Artifact class | Saga-covered | Mechanism / gap |
|---|---|---|
| memory rows (+ supersession chain) | Yes | provenance delete `deletion-saga.ts:195-223` |
| `superseded_by` pointers (cross-source survivors) | Yes | nulled + recorded `:215-222` |
| file_metadata | Yes | `:227-230` |
| MinIO original bytes | Yes | executor `deleteObject` `:363`; staging via cleanup job |
| Qdrant points (payload = content/entities) | Yes | executor `deletePoints` `:363` |
| deletion_receipt | Created (ids only) | `:244`; hash-chained + signed |
| note / chat source rows | Yes | `notes.source-deletion.ts`, `chat.source-deletion.ts` |
| verification_result (verbatim source span) | Yes | FK CASCADE `0003…sql:28` |
| memory_relation | Yes | FK CASCADE `0011:37`; contradiction lift restores partners |
| derived task rows (+ met/closed refs) | Yes | TasksCascade `tasks-cascade.ts:17` + FK CASCADE/SET NULL `0014` |
| dream_action / dormant_flag | Yes | FK CASCADE `0012:31-45` |
| outbox / job_execution | N/A (ids only) | payloads carry ids, not content |
| **dead_letter rows** | **No** | ids only, but `error` text can embed model fragments (QS-22 — FIX-3; FIX-1 added no new content sinks) |
| chat_message assistant answers | **Yes (FIX-1)** | `ChatAnswerCascade` redacts answers citing erased memories to a deletion marker; counted in `counts_json.chat_messages_redacted` — QS-7 resolved |
| audit_log `reason` detail | **Yes (FIX-1)** | model free-text no longer persisted (relation row carries it, owner-gated); migration 0020 scrubbed all pre-existing rows — QS-1 resolved |
| app_user directory | N/A | account PII, not memory-derived |

## Dependency findings (reachability judged)

| Package | Version | Advisory | Sev | Reachable? |
|---|---|---|---|---|
| multer | 2.1.1 | nested-field DoS, aborted-upload cleanup DoS | High | **Yes** — upload path (`document-upload.interceptor.ts:21`). `npm audit fix` non-breaking → **QS-12** |
| undici | 5.28.5 | decompression/smuggling/header-injection (10 advisories) | High | **Low** — prod path is only the internal, trusted Qdrant client (`@qdrant/js-client-rest`); root hits also via dev-only `testcontainers`/`dockerode`. Fix = bump Qdrant client (out of range). |
| drizzle-orm | 0.44.7 | SQLi via unescaped identifiers | High | **Low** — typed builder, static schema identifiers only; no user-supplied identifiers. Fix = breaking bump 0.45.2. |
| Python sidecar (fastapi 0.111 / uvicorn 0.30.1 / presidio 2.2.355 / spacy 3.7.5) | pinned | none headline | — | `pip-audit` not run (no venv); spaCy model fetched unpinned (QS-25). |

## Positive findings (calibration)

- **Scope gate is genuinely unbypassable.** `MemoryVectorStore.search` takes a
  **non-optional** `GateFilter`; the only search call site (`vector-store.ts:135`) is
  reached solely through `vectorSearch`, which always builds `buildGateFilter` (the
  exact mirror of the SQL `visibleTo`). No unscoped read is constructible.
- **No body/query-derived identity anywhere** — the IDOR sweep came back empty; foreign
  rows 404 uniformly.
- **Receipt hash chain is correct**: deterministic canonicalization on both sign and
  verify sides (jsonb-safe), ed25519 **signatures actually verified** (not just links),
  forks/gaps/reorders detected, concurrent confirmation serialized by advisory lock.
- **Redaction genuinely fails closed** with a real (non-mocked) test pointing a live
  client at a dead port and asserting the upstream was never called; embeddings redacted
  too (decision 0023).
- **No model-gateway bypass** — single import site, dependency-cruiser rule + source-scan
  seam test, CI-enforced; all 10 entrypoints construct via `createModelGateway`.
- **Injection surface clean**: parameterized SQL throughout, the *safe*
  `websearch_to_tsquery`, server-minted object keys (no path traversal), no SSRF, dual-layer
  citation sanitization, and a React frontend with **zero** HTML-injection sinks.
- **MinIO SSE is real and asserted at boot** (`minio-init` fails compose up otherwise) —
  closing gap-audit 3.9.
- **Compose is well-segmented** — only Caddy publishes host ports; every backing service
  is internal. Non-root Docker users; slim runtime with dev entrypoints stripped.
- **Health endpoint is honest** (probes every dependency + encryption + integrity + chain).
- **Code health**: zero `as any`/`@ts-ignore` in production paths, **zero TODO/FIXME**,
  additive-only migrations, DB-enforced append-only ledgers, container-based invariant
  tests with no sleeps, graceful worker shutdown.
- **No secrets in git history** (only `.env.example` ever tracked); demo corpus is fictional.

## Fix plan proposal (clustered; not implemented)

Ordered so HIGH clears first. Sizes: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days.

| Session | Findings | Theme | Size |
|---|---|---|---|
| **QS-A — Content leakage & deletion completeness** | QS-1, QS-7, QS-13, QS-16, QS-28 | Stop model `reason`/derived content leaking org-wide and surviving deletion; stamp org_id; chat + orphan-object cascades; payload-consistency sweep | **L** |
| **QS-B — Deletion/ingestion correctness** | QS-5, QS-26, QS-37 | Serialize delete vs in-flight pipeline (idempotency-key claim + source re-check); enforce provenance integrity; fix vector-store optionality asymmetry | **M** |
| **QS-C — Abuse & DoS hardening** | QS-2, QS-6, QS-12, QS-14, QS-27 | Rate limiting/quota, parse caps + timeouts + fact-array `.max()`, multer bump, SSE cap, bulk-tx fix | **M** |
| **QS-D — Deployment & secrets hardening** | QS-3, QS-4, QS-8, QS-9, QS-24, QS-25 | Demo fail-closed, gate console vhosts, refuse known-dev secrets, split signing-key mount, pin images | **M** |
| **QS-E — Auth/session robustness** | QS-10, QS-11, QS-15, QS-17, QS-18, QS-19 | Scope jobs endpoints, cache/revocation, eval-gate trigger, aud validation, default-deny guard, token storage | **M** |
| **QS-F — Quality & correctness cleanup** | QS-20, QS-21, QS-22, QS-23, QS-29, QS-30, QS-31, QS-32, QS-33, QS-34, QS-35, QS-36, QS-38, QS-39, QS-40, QS-41 | LIKE escaping, redaction-state logging, log-redaction depth, temporal-direction bug, approval tests, health/frontend/pool/cron nits | **L** |

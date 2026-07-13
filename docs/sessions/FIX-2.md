# Session FIX-2 — Abuse/DoS + deployment/secrets hardening

**Model:** Opus 4.8. **Implements:** the audit's QS-C (abuse/DoS) and QS-D
(deployment/secrets) clusters — QS-2, QS-6, QS-12, QS-14, QS-27 and QS-3, QS-4,
QS-8, QS-9, QS-24, QS-25. **No decision record** (no Addendum Part-A deviation;
these are the audit's externally-reviewed fix scopes implemented faithfully).
**No migration.** **New dependency:** `multer` pinned to `2.2.0` (a patch of the
already-transitive version — QS-12, not a new framework). Follows QS-B (0024)
and FIX-1 (0025) in the audit-fix series. **Standing rules held:** no git, no
root tests/, every limit env-configurable with a sane default, every fix tested.

## Abuse / DoS

**QS-2 — rate limiting + per-user daily model budget.** An in-process
per-principal fixed-window `RateLimitGuard` (`@RateLimit('<bucket>')`, keyed on
the resolved principal, runs after the bearer guard) throttles chat / capture /
remember / upload. Separately, a per-user **daily model budget** (calls +
estimated tokens ≈ chars/4) is enforced in a gateway decorator
(`BudgetedModelGateway`) that attributes calls to a principal via a per-request
`AsyncLocalStorage` scope (opened by app middleware, filled by the bearer
guard). The worker opens no scope, so its pipeline traffic is unattributed and
**unmetered** — bounded instead by the daily capture/upload cap (QS-6), which is
why the demo seed's pipeline work doesn't blow the budget. Over-budget surfaces
as a `model_budget_exceeded` SSE error event (chat, mid-stream) or a 429 (other
paths, via `ModelBudgetExceptionFilter`). `demoMode` auto-selects an aggressive
set (own `COGETO_DEMO_*` env namespace) since the sandbox shares one token
across all visitors. In-memory counters (single app process per tenant, §A.2)
with UTC-midnight rollover — a restart clearing them is not attacker-driven, and
rate limiting bounds the residual. All env-configurable (`.env.example`).

**QS-6 — parse caps + ingest quota.** `document-extract` wraps the parse in a
wall-clock timeout and rejects text over a decompressed-length cap (both →
`PermanentExtractionError`: error state, zero model calls — the 25 MB upload cap
only bounds *compressed* input). The pipeline caps chunk count (bounds
extraction calls) and total facts per source (bounds verify/reconcile/embed);
`extractionOutputSchema.facts` gained a `.max()`. NotesService/FilesService
enforce a per-user daily capture/upload cap (429). All env-configurable.

**QS-12 — multer.** Pinned to `2.2.0` via a root `overrides` + a direct
dependency (the interceptor imports it directly anyway); a bare `npm audit fix`
would have dragged in breaking drizzle/testcontainers bumps, so it was pinned
surgically. `npm audit` now reports **0 multer advisories**.

**QS-14 — SSE bounds.** The chat controller caps concurrent streams per
principal (429 *before* any header is sent) and races each generator step
against an idle timeout and a hard max-duration `AbortController`; on abort it
writes a `timeout` error event, asks the generator to stop (fire-and-forget —
awaiting a generator suspended on a never-settling upstream would hang), and
releases the slot in `finally`.

**QS-27 — bulk Qdrant outside the lock window.** `bulkMarkOutdatedForOwner` now
transitions **PG-only** (`transitionInTx({ syncPayload: false })`), returns the
changed ids, and the Qdrant payload sync runs **after commit** via a new
`afterCommit` continuation threaded through `idempotentTask` → the approval
executor → the worker task. Best-effort (logged, not retried, never
dead-letters); the FIX-1 payload-consistency sweep is the backstop. No row lock
is held across the per-row Qdrant HTTP calls.

## Deployment / secrets

**QS-3 — demo fail-closed.** `/api/config` serves the demo session ONLY with an
explicit `COGETO_DEMO_MODE=1` (`production || !demoMode` → base config); file
presence never flips it. The app logs its effective serving mode at boot. The
`demo` compose profile now documents that the flag is required.

**QS-4 — consoles behind a profile + Qdrant key.** The `s3` / `minio` / `qdrant`
vhosts moved out of the public Caddyfile into `Caddyfile.consoles`, served by a
`caddy-consoles` service under the `consoles` profile bound to `127.0.0.1` only.
The default deployment exposes exactly the app vhost. Qdrant gets
`QDRANT__SERVICE__API_KEY` (from `COGETO_QDRANT_API_KEY`), threaded through every
client construction (module + all bare entrypoints). Consequence: presigned O1
downloads (the `s3.localhost` origin) now require the `consoles` profile — a
documented tightening of the already-known download gap.

**QS-8 — refuse known dev secrets.** A `preflight` init container (the only
process handed every secret — Postgres/MinIO/Zitadel/KMS) refuses to boot when
any committed dev value guards a non-localhost deployment; app/worker/zitadel/
migrate depend on it. `loadConfig` re-checks the app-visible subset as defense
in depth. A no-op on a localhost dev box.

**QS-9 — split the signing-key mount.** `migrate` publishes the public half into
a separate `instance-pubkey` volume; the app mounts that public-key-only volume
and asserts at boot the private key is unreachable (`assertAppKeyMount`); the
worker keeps the full pair. An app-side RCE can no longer exfiltrate the
receipt-signing private key.

**QS-24 — Zitadel masterkey off the command line.** Zitadel starts with
`--masterkeyFromEnv` reading `ZITADEL_MASTERKEY` from the environment; the key is
no longer visible via `docker inspect` / in-container `ps`.

**QS-25 — pin images + spaCy model.** Every base image (node, caddy, postgres,
qdrant, minio, mc, busybox, zitadel, python) pinned by digest; the spaCy
`en_core_web_lg-3.7.1` model pinned to an exact wheel URL. Update procedure:
`docs/operations/image-pins.md`. A static test fails CI if any `image:` reverts
to a bare tag.

## Tests

New: `secret-preflight.spec` (QS-8), `abuse-control.spec` (rate guard + budget +
counters, QS-2), `budgeted.gateway.spec` (QS-2), `document-extract-caps.spec` +
`candidate-fact.spec` (QS-6), `web-config.spec` (QS-3 fail-closed),
`deployment-hardening.spec` (QS-4/8/9/24/25 static + the key-mount guard),
`chat-sse-limits.spec` (QS-14). Extended: pipeline `parse_caps` (QS-6), notes
`daily_capture_cap` (QS-6), approvals `bulk_outdate_syncs_qdrant_after_commit`
(QS-27). Existing NotesService/FilesService constructions updated for the new
quota args.

## Verification

- Full Vitest suite green (241 tests; the transient env-consistency miss on a
  stray `COGETO_DEMO_*` doc token was fixed). Lint (eslint + prettier),
  dependency-cruiser (307 modules, 0 violations), `tsc` build, web build: green.
- `docker compose config` validates; compose-to-login on the default profile and
  the `redaction`/`consoles` profiles; demo profile run under the new caps
  (`COGETO_DEMO_MODE=1`) confirmed the sandbox still seeds and answers.
- Golden-set + chat eval gates unaffected (no prompt/model change).

## Owner checklist (the six manual checks)

1. **Rate limit:** loop `POST /api/chat` past the per-window cap → HTTP 429 with a
   retry hint; the SPA shows the message.
2. **Daily budget:** set `COGETO_MODEL_DAILY_CALLS=2`, ask 3 questions → the 3rd
   returns a `model_budget_exceeded` error in chat.
3. **Parse cap:** set `COGETO_PARSE_MAX_TEXT_CHARS=1000` and upload a larger
   document → the file's status reads `error`, zero memories, zero model calls.
4. **Demo fail-closed:** `docker compose up` (no `COGETO_DEMO_MODE`) with a
   `session.json` present in `demo-config` → `/api/config` returns no
   `demoSession`; the boot log says mode `standard`.
5. **Consoles gated:** `curl -k https://<host> -H 'Host: qdrant.localhost'`
   against the default stack → not served (only the app vhost answers); the
   consoles resolve only via `--profile consoles` on `127.0.0.1:8443`.
6. **Key split + secrets:** `docker compose exec app ls /instance-keys` shows the
   `.pub.pem` only; setting `COGETO_EXTERNAL_DOMAIN` to a real domain without
   overriding the dev secrets makes the `preflight` container fail `compose up`.

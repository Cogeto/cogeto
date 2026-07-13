# Session FIX-3 — audit remediation (auth cluster + quality cluster)

**Date:** 2026-07-13. **Scope:** the last open findings from
`docs/audits/quality-security-audit.md` — QS-10, QS-11, QS-15, QS-17, QS-18,
QS-19 (auth) and QS-20–23, QS-29–41 (quality). With this session **all 41 audit
findings are RESOLVED**; the owner re-runs the audit prompt at O6 as the launch
check.

**Standing rules kept:** no git commands; no root `tests/` dir; no behaviour
changes beyond the findings; every limit configurable via a documented env with a
sane default; every fix tested. Decision records only where required — **0026**
(QS-11 revocation stance + QS-23 anchoring). Decisions now at **0026**.

## Conservative-option rationales (one line each, as instructed)

- **QS-10** — gated the jobs endpoints by an **admin role** (`AdminGuard`,
  configurable `COGETO_ADMIN_ROLE`, default `admin`), not owner-scoping: most
  queue jobs (sweep/dream/backfill/expiry) carry no user owner, so per-owner
  filtering would both hide operational state and leak by omission.
- **QS-11** — lowered the Principal cache TTL to **10s** and accepted the ~10s
  residual revocation window as a *stated* bound (README + decision 0026),
  rather than per-request userinfo or push-revocation, given the single-tenant
  boundary (0019).
- **QS-17** — **decode-only** local `iss`/`aud` validation (no signature verify —
  userinfo proves the token); opaque tokens (demo PAT) skip the check.
- **QS-18** — global guard via `APP_GUARD useExisting: BearerAuthGuard` +
  `@Public()` on exactly health/config/instance; a real-app default-deny test.
- **QS-19** — strict CSP on the SPA `handle` only (never the proxied Zitadel UI /
  API); `script-src 'self'`, no third-party, no `unsafe-inline`. sessionStorage
  tradeoff recorded as accepted in the Caddyfile.
- **QS-21** — loud boot log **and** a `REDACTION_REQUIRED` fail-closed env (the
  app can't see the compose profile, so this lets a deployment refuse boot
  without redaction — the achievable "refuse profile-without-env").
- **QS-31** — filtered `changesSince` audit arm by `auditLog.ownerId = caller`
  (those rows are always owner-stamped; v1 notes are private), keeping
  `getManyForPrincipal` as the defence-in-depth scope re-check.
- **QS-32** — threaded a configurable instance timezone via a new
  `INSTANCE_TIMEZONE` DI token on the (global) LimitsModule → ingestion anchor +
  retrieval rewrite; default `Europe/Zagreb`.
- **QS-38** — set an explicit configurable `COGETO_PG_POOL_MAX` (default 10) on
  both pools and **kept** the pipeline tx open across model calls deliberately
  (read the FIX-1 log first — the QS-B admission redesign did not remove it; a
  retry must leave no partial rows), documenting the choice on the config field.
- **QS-39** — `TZ=UTC` on the worker (compose) for stable crons + `runSingleFlight`
  (named advisory lock) on every recurring nightly job; DST note in worker.ts.
- **QS-40** — added the depcruiser rule confining `pg` to composition roots; the
  two named raw-SQL sites already live in `entrypoints/` (the sanctioned
  location), so they stay put — the rule just makes a domain-module Pool fail CI.
- **QS-15** — PR runs the **build** (mocked path, no key); the live-key eval runs
  only on `push` to main.

## Key mechanisms (see each finding's RESOLVED line for the full detail)

- **New:** `error-scrub.ts` (from FIX-1), `redaction-boot.ts`, `public.decorator.ts`,
  `admin.guard.ts`, `INSTANCE_TIMEZONE`/`DEFAULT_INSTANCE_TIMEZONE` tokens,
  `runSingleFlight`, `acquireDemoResetLock`, `ModelGateway.reachable()`,
  `query-invalidation.ts` (web), decision 0026.
- **Tests added:** `default-deny.guard.spec`, `admin.guard.spec`, QS-17 cases in
  `identity.service.spec`, temporal QS-29/QS-32 golden cases,
  `approval_concurrent_confirm` in the approval integration suite.

## Verification (all green)

- `npm run build` (shared + server + web) ✓
- `npm run lint` (eslint + prettier) ✓
- `npm run boundaries` (dependency-cruiser, incl. the new pg rule) ✓ (314 modules)
- Full Vitest suite (`vitest run`, incl. Testcontainers integration) exit 0 ✓
- `docker compose config -q` valid; worker resolves `TZ: UTC`, `REDACTION_REQUIRED`
  wired on app+worker ✓
- Audit doc: all 41 findings carry a dated RESOLVED line; executive summary
  refreshed to "ALL 41 findings RESOLVED".

## Owner-run (need live credentials / a full boot — not runnable here)

- `docker compose up` reaching **login** on a fresh clone (heavy Zitadel boot).
- Both **eval suites** live: `npm run eval` + `npm run eval:chat` need
  `MISTRAL_API_KEY` (absent here by design — QS-15 moved the live gate to
  push/main). The PR mocked path (build) is green.
- The **eval-gate** GitHub workflow's new push-only gating (can only be observed
  on an actual push to main).

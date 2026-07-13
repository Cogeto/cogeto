# 0027 — The Ana sandbox is password-gated, not auto-open (revises 0022 ruling 1)

**Status:** Accepted. **Context:** decision 0022 ruling 1 made the Ana sandbox
**auto-open**: the demo-seed job provisioned a machine-user Principal + PAT and
the app published that bearer token on the already-public `GET /api/config`, so
the SPA installed it and any visitor was logged in as Ana with no credentials.
The owner wants the demo to keep all its capabilities (seed, reset-to-defaults)
but require a **login with a generated password** so it is not always open.

## Ruling 1 — an app-level password gate over the existing sandbox

1. **Ana is unchanged.** She stays the same Zitadel machine user that owns the
   seeded world (same `user_id`, same idempotent provisioning, same PAT). We did
   NOT convert her to a human Zitadel user: Zitadel (v2.65) has no password-grant
   flow, so a "real" human login would force the seed job to perform a headless
   OIDC login to own the data — significant, version-brittle machinery for no
   product gain over a gate. The gate is an **application-level** credential
   check, deliberately, not a second identity system.
2. **A generated password, surfaced only to the operator.** The seed generates a
   strong random password (`demo/credentials.ts`) and writes it to two files on
   the `demo-config` volume next to `session.json`: `demo-login.json` (machine-
   readable, read by the app to verify a login) and `demo-credentials.txt`
   (human-readable). The seed/reset **jobs also print it** in their logs. The
   password is **never** placed on `/api/config` — that is the whole point.
3. **The token is no longer published.** `GET /api/config` returns
   `{ demoMode: true, demoLogin: true }` on a demo instance but **no token**. A
   new `POST /api/config/demo-login` takes `{ username, password }`, verifies them
   against `demo-login.json` with a length-guarded constant-time compare, and only
   then returns the demo session token. Both endpoints stay FAIL-CLOSED (QS-3):
   on a production or non-demo instance they expose nothing (same `401`, no
   existence leak). The SPA shows a small login form instead of auto-installing.
4. **Password lifecycle: stable across restarts, rotated on reset.** A mere
   container restart REUSES the persisted password (so the operator's known
   password keeps working); every `demo:reset` — manual or the worker's scheduled
   6-hourly reset — ROTATES it to a fresh value and reprints it. This matches the
   owner's "generated password each time [you reset]" intent without logging the
   operator out on every restart. Ana's `user_id` is stable, so a reset re-seeds
   the same owner's world; an open, already-authenticated tab survives a reset
   until its token expires.
5. **Username.** The login username is the fixed `ana@cogeto.localhost` (matching
   the `admin@cogeto.localhost` style); only the password rotates.

## Consequences

- The sandbox is no longer open to anonymous visitors: without the password
  (which only the operator running Docker can see) there is no access. Suitable
  for a shared demo host in a way the auto-open model was not.
- This is an application credential, not Zitadel auth — it authenticates *into*
  Ana's existing session rather than minting a per-visitor identity. Acceptable
  for a single-tenant, disposable sandbox (decision 0022's framing is unchanged
  in every other respect).
- The generated password is strong enough that online guessing is infeasible; no
  rate limiter is added for the local sandbox (noted, not required).

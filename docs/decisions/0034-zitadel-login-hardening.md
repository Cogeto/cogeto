# 0034 — Zitadel login-surface hardening defaults

Date: 2026-07-21. Status: accepted.

## Context

Zitadel instances were provisioned with its stock login surface: self-service
registration open, an external-IdP section (with no IdPs configured), login
errors that reveal whether a username exists, and public organization
registration allowed. Cogeto instances are single-tenant with operator-created
users (runbook onboarding); none of these surfaces has a legitimate use, and
each is either an attack surface or a dead end.

## Decision

`zitadel-init` (which re-runs idempotently on every `compose up`, so existing
instances converge on their next upgrade) ensures at the instance level:

1. `allowRegister: false` — no self-registration; users exist only when the
   operator creates them. Forgotten passwords are handled by the admin setting
   a temporary password with "change required", forcing the user to choose
   their own at next login.
2. `allowExternalIdp: false` — no identity providers are configured; the dead
   UI section is removed.
3. `ignoreUnknownUsernames: true` — a failed login does not reveal whether the
   account exists (anti-enumeration).
4. `disallowPublicOrgRegistration: true` (instance restriction) — a customer
   instance is single-tenant (decision: deployment boundary); no path may
   create a second organization.

**Self-verifying application:** after any change the script re-reads the
policy/restriction and fails the boot if a desired value did not stick.
Rationale: Zitadel's proto-JSON API silently ignores unknown fields and omits
false-valued booleans from responses — both were observed during
implementation; without re-read verification a typo'd field name would report
"hardened" while changing nothing.

## Consequences

- The login page shows exactly one path: username + password (verified: zero
  register references served).
- Existing instances need no manual pass — the init job applies and verifies
  the settings on their next upgrade.
- Static assertions in `deployment-hardening.spec.ts` prevent the hardening
  step from being silently removed.
- Not included (future candidates, owner decision): `hidePasswordReset`
  (instances have no outbound SMTP, so the email-reset path is a dead end),
  password complexity/lockout policies, forced MFA, branding/watermark,
  privacy-policy links.

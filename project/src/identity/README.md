# identity — seam (bounded context)

The thin abstraction between Cogeto and **Zitadel** (scope §4.5). Zitadel answers
"who is this user and what org/roles do they have"; it never decides which memories
they can see — memory scoping is Cogeto's own backend logic. The rest of the system
depends on this module's interface and **never calls Zitadel directly**.

Provides: authenticated principal, organization ID (also the first segment of object
keys — Addendum §A.6), roles. The Zitadel org/admin/OIDC bootstrap lives in
`project/infra/` (§A.2), not here.

Owns: no domain tables.

May depend on: nothing inside `src/` — this is a leaf seam. All modules may depend on it.

## Principal cache and the token-revocation window (QS-11, decision 0026)

To avoid a Zitadel userinfo round-trip on every request, a validated bearer
token's Principal is cached for `cacheTtlSeconds` (**default 10s**, set by both
composition roots). This has one **accepted, stated** consequence: a token
revoked or expired at the IdP keeps working until its cache entry expires — a
**residual revocation window of at most ~`cacheTtlSeconds` seconds**. We
deliberately keep a small non-zero TTL (rather than validating every request or
adding push-revocation) because the single-tenant deployment boundary
(decision 0019) plus a 10-second bound makes this an acceptable operational
property. Lower `COGETO`-side config / the registration value to shrink the
window at the cost of more userinfo traffic; it is never unbounded.

Independently, the seam **locally pre-validates** each JWT's `iss` (against the
configured issuer) and `aud` (against the SPA client id) before trusting the
cached userinfo (QS-17) — a wrong-issuer/wrong-audience token is rejected with
no network call. Opaque tokens (the demo PAT) skip the decode and rely on
userinfo. Default-deny auth: the bearer guard is registered globally (QS-18);
only routes marked `@Public()` (health, config, instance public-key) opt out.

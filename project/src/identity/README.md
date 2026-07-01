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

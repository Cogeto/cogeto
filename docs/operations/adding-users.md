# Adding a user to a Cogeto instance

**Audience:** the operator of a single Cogeto instance. **Model:** Cogeto is
**single-tenant** — one Zitadel *organization* per instance, and that org *is*
the account (Addendum §A.6; scope doc §4.2). Everyone you add here is a member of
the same org and can therefore see each other's **shared**-scope memory; nobody
outside the instance can. Cross-tenant isolation is a *deployment* boundary
(separate instances), not something you configure per user — see
[decision 0019](../decisions/0019-cross-org-isolation-deployment-boundary.md).

There is **no app-side provisioning step**: Cogeto derives the Principal straight
from the Zitadel token on first request and records the user in its directory
automatically (for owner-name display). You only create the user in Zitadel.

## Prerequisites

- The instance is running (`docker compose up` reaches the login page).
- You can sign in to the **Zitadel Console** as the org admin the bootstrap job
  created (locally: `admin@<ZITADEL_EXTERNAL_DOMAIN>`, e.g.
  `admin@localhost`, password from your instance's `FirstInstance` config).
- The `cogeto` project and its `cogeto-web` OIDC SPA already exist (created once
  by `zitadel-init`). **You do not create a new app per user** — every member
  logs in through the same SPA with PKCE.

## Steps (Zitadel Console)

1. **Open the Console** at your instance domain (e.g. `https://localhost`, then
   the Zitadel Console link) and sign in as the org admin.
2. **Select the organization.** Top-left org switcher → choose the instance's org
   (the one created at bootstrap; there is only one). All users you add live
   here.
3. **Create the user.** Left nav **Users** → **+ New**.
   - Fill **Email**, **First/Last name**, **Username**.
   - Choose **Set initial password** (hand it over out-of-band) or **Send an
     email invitation** so the user sets their own. Save.
   - The user is now a **member of this org** — that membership alone is what
     Cogeto needs. (Verified email / SSO login work the same as for the admin.)
4. **Role (optional in v1).** Cogeto v1 gates visibility on *memory scope*, which
   is Cogeto's own logic — **not** on Zitadel project roles (scope doc §4.5;
   glossary "Principal": roles are empty until roles are defined). So a plain org
   member can use every surface immediately. **If** your instance has defined
   project roles on the `cogeto` project and you want to grant one:
   **Projects → `cogeto` → Authorizations → + New**, pick the user, grant the
   role. It flows into the token's `urn:zitadel:iam:org:project:roles` claim and
   appears in `Principal.roles`; nothing in v1 requires it.

## OIDC / role prerequisites (why this is all that's needed)

- **One SPA, many users.** `cogeto-web` is a public PKCE client; adding a user
  does not touch its config. The token the user receives carries `sub` (user id),
  the org (`urn:zitadel:iam:user:resourceowner:id` / `…:name`), and any project
  roles. The identity seam reads exactly those claims
  (`identity/identity.service.ts`).
- **No pre-created rows.** `user_settings` is created lazily on the user's first
  write (defaults: private scope, no discard); the `app_user` directory row is
  written on first authenticated request. A brand-new user with an empty account
  is fully functional.

## First-login walkthrough (what the new user sees)

1. They open the instance URL, are redirected to Zitadel, sign in (password or
   SSO), and land on the dashboard.
2. **Empty states are correct everywhere:** no memories, no tasks, an empty
   Review queue, an empty Forgotten list, no digest panel. Nothing errors.
3. They capture a note — scope defaults to their Settings default (**private**
   until they change it). Private facts are theirs alone.
4. If a teammate has captured **shared** facts, the new user sees them in
   Memories (badged **shared**, attributed "owned by <teammate>"), can retrieve
   them in Chat (citation shows the owner), but **cannot** approve, edit, change
   the scope of, or delete them — those controls are hidden with an explanation,
   and the server rejects them regardless.

## Removing / disabling a user

Deactivate or delete the user in the Console (**Users → the user → Deactivate**).
Their **private** memory remains in the instance (owned data is not auto-purged);
use the in-app deletion saga to remove specific sources if required. Their
**shared** memory stays visible to the org (it was contributed to the shared
pool). True erasure of a departed user's data is an operator action via the
deletion surface, tracked by signed receipts (§B.1).

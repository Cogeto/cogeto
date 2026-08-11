# The Confluence connector: what its token can do, and what enforces read-only

**V2.5 item 8.2. Companion to the decision record,
[`docs/features/confluence.md`](../features/confluence.md); co-located tests:
`project/src/confluence/read-only.spec.ts`.**

## The honest statement

Cogeto's Confluence connector only reads. It never creates, edits, deletes,
moves, archives or otherwise mutates anything in Confluence. The interface
says so at the moment of connecting, and this page says what enforces it.

**What enforces it is Cogeto's implementation, not the credential.** An
Atlassian API token carries the FULL permissions of the account it belongs
to. There is no way to mint a read-only API token on Atlassian Cloud: if the
account can edit a page, the token can edit that page. So the read-only
property rests on Cogeto's client, and Cogeto makes that structural rather
than a matter of intent:

- The Confluence client (`project/src/confluence/client.ts`) has exactly one
  request helper, and it hard-codes `method: 'GET'`. No create, update or
  delete method exists anywhere in the module.
- An architecture assertion (`read-only.spec.ts`, part of the required
  `test` check) fails the build if a mutating HTTP verb, or any second HTTP
  call site, appears in the module. A future change cannot quietly introduce
  a write.
- The credential is sealed with the instance master key at rest
  (`connector_credential`, AES-256-GCM under `COGETO_MASTER_KEY`), can be
  decrypted only in the worker process, is never returned by any endpoint,
  never logged, and is destroyed immediately and auditably when the
  connector is removed.

## The stronger arrangement, recommended

For security-conscious deployments, do not take Cogeto's word for it: make
Confluence enforce the restriction too. Create a **dedicated Atlassian
account** for Cogeto and grant it **read-only space permissions** on exactly
the spaces you intend to sync:

1. Create a new Atlassian account (for example `cogeto-reader@yourdomain`),
   licensed for Confluence.
2. In each space to be synced: Space settings, Permissions, grant the
   account **View** only (no Add, no Delete, no Admin).
3. Grant it nothing anywhere else: no global admin, no product admin, and no
   membership in groups that carry write permissions.
4. Create the API token from THAT account and connect Cogeto with it.

With this arrangement the blast radius of a leaked token is read access to
the chosen spaces, and the read-only property is enforced by Confluence's
own permission model, independently of any client behaviour. It costs one
account and ten minutes, and it also gives you a clean audit line on the
Atlassian side: everything Cogeto did is attributable to its own account.

## Scope of access, stated plainly

Whatever the account can see, the connector can read: the user chooses which
spaces (or page subtrees) are synced, and nothing outside the selection is
ever fetched, but that selection is enforced by Cogeto, not by Atlassian.
Content restricted to a subset of users is skipped and reported rather than
ingested (spec 4.4.4). A revoked or invalidated token moves the connector to
`needs_reauth` with an actionable message; it never fails silently.

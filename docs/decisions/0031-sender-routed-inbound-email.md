# 0031 — Inbound email is sender-routed; the capture-owner concept is removed

**Status:** Accepted. **Revises:** decision 0028 **ruling 3** (owner mapping)
and the corresponding parts of rulings 2/7 (whose allowlist gates acceptance).
Everything else in 0028 stands — per-tenant addressing (ruling 1), receive-only
(ruling 4), full retention (ruling 5), anti-abuse hygiene (ruling 6), the
authoritative app-side intake surfaced at SMTP (ruling 7), and the
transactional safe order (ruling 8).

**Context:** the first real fresh-VM dry run (O6, v0.9.0) proved 0028's owner
mapping cannot work in production. It resolved ONE capture owner per instance:
`COGETO_MAIL_CAPTURE_USER_EMAIL` if set, else "the sole directory user". But a
production instance **always** has at least two users — the operator's
bootstrap admin and the customer — so the sole-user fallback never applies,
the env var was never set by provisioning, and every message was refused
`no_owner`. Worse, the refusal UX offered "add to allowlist" for a failure
allowlisting cannot fix, and entries added by the admin were inert (the
intake consulted the capture owner's list). The owner rejected pinning a
single capture owner per instance and chose sender routing.

## Ruling 1 — Recipient users are resolved from the sender

For each message accepted at the recipient/size gates, in order:

1. **A sender matching a registered user's email is captured for that user.**
   Every user's own address is implicitly trusted (shown in Settings as an
   always-on entry). This automatically covers the two primary capture flows —
   a manual **forward** and a **BCC** both arrive from the user's own
   address — with zero configuration.
2. **Otherwise, every user whose personal allowlist matches the sender
   receives their own copy.** The allowlist's meaning is now personal
   routing: *"senders whose mail I want in my memory"* — which is exactly the
   provider-side **auto-forward** case, where the original external sender is
   preserved. Multi-match is copy-to-each by design: each matching user
   explicitly opted into that sender; there is no instance-wide allowlist and
   no conflict to resolve.
3. **Nobody matches → refused** (`sender_not_recognized`), closed by default.
   The refusal row carries no owner and appears in every user's "Recently
   refused", so any user can claim the sender in one click.

Matching still uses the 0028 ruling 2a normalization (envelope `MAIL FROM`
first, header `From` fallback, normalized `local@domain`).

## Ruling 2 — The bootstrap admin account never captures

The operator's admin login (`COGETO_ADMIN_USER_EMAIL`, wired by compose from
`ZITADEL_ADMIN_USERNAME` in both the dev and deploy stacks) is excluded from
both routing rules. The operator account stays clean of customer memory; a
customer who should also operate gets the admin *role*, not the admin *user*.

## Ruling 3 — `COGETO_MAIL_CAPTURE_USER_EMAIL` is removed entirely

Not deprecated — removed: config schema, `MailOptions`, both compose files,
`.env.example`, docs. There is no capture-owner pin and no operator step; the
routing needs none. (Per-user *addresses* — `capture-<user>@in.<domain>` —
remain the possible v1.x extension for finer routing; the schema already
carries `owner_id` everywhere, so that extension still needs no migration.)

## Ruling 4 — Captured email follows the owner's default capture scope

The intake stores each copy under the resolved recipient's **default scope**
from Settings (previously hardcoded `private`), matching how notes behave.
Sharing stays per-memory afterwards. Sensitive remains `false` at intake.

## Ruling 5 — Refusal transparency

Refusal reasons are shown in plain words in Settings; the one-click
"Allow this sender" appears **only** for sender-identity refusals
(`sender_not_recognized`, plus the legacy `sender_not_allowlisted`/`no_owner`
rows), never for size/recipient refusals it cannot fix.

## Spoofing stance (unchanged from 0028, restated deliberately)

Sender addresses are forgeable, so routing by sender is an
*acceptance-scoping* control, not authentication — someone who knows a user's
address can inject a memory into that user's account. This is the same trust
class 0028 accepted for the allowlist (spoofing an allowlisted sender did the
equivalent), defensible because single-tenant isolation (decision 0019)
bounds the blast radius to memory the tenant already chose to trust.
SPF/DKIM verification remains the documented later hardening.

## Redelivery note

Copy-to-each stores copies sequentially; a mid-loop failure returns a
transient error to Haraka (451 → sender retries), so a copy can be delivered
twice. The pipeline's idempotency keys and thread-aware dedup absorb the
re-delivery; accepted as the simple, honest failure mode.

## Consequences

- The dry-run scenario (admin + customer, zero configuration, customer
  forwards mail) now works out of the box — covered by the
  `self_sender_routes` integration test, plus `admin_excluded`,
  `copy_to_each`, and `default_scope_respected`.
- `UserDirectory.resolveCaptureOwner` is replaced by `userByEmail` +
  `usersByIds`; `EmailAllowlistService.matches(owner, sender)` by
  `ownersMatching(sender)`; `IntakeResult` returns `emailIds[]`.
- The operator runbook and email notes are updated to the new model in the
  companion docs change (o6-dry-run unit).

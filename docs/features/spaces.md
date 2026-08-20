# Spaces

Status: DRAFT decision record, written before code. Owner decisions recorded
2026-08-19: no per-space membership, and no moving sources between spaces in v1.
Amended 2026-08-19, before any code, with two further owner decisions: the
Memory Passport is per space, and the receipt chain is per space (section 5).

## 1. What a Space is

A **Space** is a fully sealed partition of a Cogeto instance. Everything
content-bearing lives inside exactly one space: memories, sources, files,
chats, conversations, research runs, skills, contradictions, findings
reports, projects, imports, connectors, the suppressed fact log, attention
items, and the receipts for space content.

**The isolation rule is absolute and by design.** No retrieval, no
reconciliation, no deduplication, no comparison, no linking, no reporting,
and no feature of any kind ever operates across two spaces. Two spaces
relate to each other exactly like two separate Cogeto instances: not at
all. There is deliberately NO "compare spaces" feature and none may ever be
added. A fact captured in space A is invisible in space B even to the same
user.

**Hierarchy:** Instance, then Spaces (hard walls), then Projects (soft
lenses, existing feature, unchanged), then Sources, then Facts.

**Projects are untouched** and nest inside a space. They remain
organization and filtering (the retrieval lens), never a gate, exactly as
the frozen decision record [`projects.md`](projects.md) states. That rule
now applies within a space: the space is the gate, the project is the lens.
Projects are not renamed.

## 2. Default space and login

- Every instance has one **default space**, created by migration. All
  existing data (every memory, source, conversation, project, report and so
  on) is migrated into it. Nothing is lost and nothing changes behavior for
  a single-space instance: one space must be byte-identical to the product
  before this feature.
- On login the user lands in the space they last used (persisted per user),
  falling back to the default space.
- The default space can be **renamed** like any other. It cannot be deleted
  while it is the only space.

## 3. Navigation and UX

**The space switcher lives in the top navbar** (where page names are now),
as the leftmost element: a modern combobox dropdown, in the style of
Vercel's team switcher or Linear's workspace menu.

- Shows the current space name prominently. The current space must be
  visible at all times on every page. This is the single most important UI
  state in the product, since a sealed space's first user-visible behavior
  is "where am I?".
- Clicking opens a dropdown: the list of spaces (with a checkmark on the
  current one), a search field when there are more than about 7, and a
  pinned **"+ New space"** action at the bottom.
- **Create flow:** click "+ New space", an inline dialog with one field
  (name), create, and the user is switched into the new, empty space
  immediately. One field, one click, done. No wizard.
- **Switch flow:** pick a space from the dropdown and the switch is
  instant. A lightweight confirm ("Switch to Marketing?") only if there is
  unsaved state; the default is instant. The whole app context swaps:
  dashboard, sources, chats, everything now shows only that space. Target
  under one second perceived.
- **Rename:** available from the dropdown (kebab or pencil on hover) or in
  space settings. A command palette entry or quick-switch shortcut is a
  nice-to-have.
- An empty new space shows a friendly first-run state pointing at Chat and
  Sources, not a blank dashboard.

**Relocation of instance-level surfaces (important).** The current sidebar
mixes space content with instance administration. Split it:

- **Sidebar (space-scoped, everything here changes with the switcher):**
  Dashboard, Chat, Sources, Research, Skills, Time travel, Contradictions,
  Approvals, Reports, Forgotten.
- **Instance area (space-independent), moved out of the sidebar into a
  gear icon menu at the right end of the navbar** (next to the user avatar,
  an instance settings panel with its own left nav, Notion or GitHub
  style): Providers, Models, System, Audit, Users, and the instance-level
  parts of Settings. These are administrator surfaces about the deployment,
  not about any space's content; visually separating them reinforces the
  mental model that spaces do not own them.

## 4. Settings split

The rule: any setting that influences what is extracted, stored, retrieved
or answered is space-scoped; any setting about identity, appearance or
infrastructure is instance-scoped.

| Section | Level | Notes |
|---|---|---|
| Capture and upload defaults (default scope, extract-and-discard) | **Per space** | Defaults naturally differ per topic; stored per user per space |
| Profile and context (name, company, role, timezone, language, strict language) | Instance (per user) | Identity does not change with topic |
| Appearance (theme) | Instance (per user, per device) | Unchanged |
| Web research (auto-research toggle) | **Per space** | Research behavior is content behavior |
| Model configuration (read-only view) | Instance | Moves to the instance area with Providers and Models |
| Extraction gate rules, entity aliases, email routing, connector configuration | **Per space** | These shape content processing, so they are sealed with the space |
| Answer-model choice (the user-switchable tier) | Instance (per user) | Model choice is infrastructure, not content |

Audit remains ONE instance-level, administrator-only trail (per the
existing issue #633 decision), but every audited action gains a `space_id`
attribute so an administrator can filter by space.

## 5. Data model and enforcement

Guidance, not prescription.

- New `space` table (id, name, created_at). New `space_id NOT NULL` column
  (FK) on every content-bearing root: source, memory, conversation,
  project, import_run, research_run, report run, connector, and so on.
  Child tables inherit through their root where joining is natural; the
  access-gate tables (memory, and the Qdrant payload) carry `space_id`
  directly.
- **`space_id` becomes the third hard dimension of the access gate**,
  beside owner and scope: added to `buildGateFilter` in SQL and to the
  Qdrant payload pre-filter. Like the existing gates it is enforced inside
  every query, in both stores, so an un-spaced read is unrepresentable.
  The existing `projects-are-not-a-gate` structural test gets a sibling,
  `spaces-are-a-gate.spec.ts`, asserting the gate carries the dimension
  everywhere, and that reconciliation candidate selection, deduplication,
  contradiction pairing, the checked-pair ledger, the nightly pass, entity
  aliases and ambiguity clustering are all space-scoped.
- **Reconciliation never pairs across spaces.** This is the heart of the
  feature. Duplicate-upload checksum dedup also becomes per space: the same
  file uploaded into two spaces is two independent sources, by design.
- The pipeline stamps `space_id` at capture, upload, import or
  connector-sync time from the caller's current space, inside the same
  transaction that creates the source (the same pattern projects use for
  stamping).
- Deletion: erasing a space's content reuses the ORDINARY deletion saga per
  source (the owner-erasure pattern: enumerate, run the existing saga, one
  receipt per source). Deleting a space itself requires the space to be
  empty or runs that enumeration; the confirmation states exactly what will
  be erased. No second deletion mechanism.
- **The receipt chain is per space** (owner decision, 2026-08-19). Each
  space owns its own chain: its own genesis, its own sequence, its own tip.
  A receipt links only to the previous receipt within its space.
  Canonicalisation and the signature format do not change. The existing
  chain becomes the **default space's chain unchanged**, so every
  historical receipt continues to verify byte-identically; every new space
  starts at its own genesis.
- **The Memory Passport is per space** (owner decision, 2026-08-19). A
  passport exports one space, never the whole instance grouped by space.

  Why the two decisions are one: a passport carries a space's deletion
  receipts so a third party can verify them independently, standalone. With
  a single instance-wide chain, those receipts would reference the hashes
  of receipts belonging to other spaces, which are not in the export and
  must never be. Per-space chains make a space's receipts verifiable
  standalone, which is exactly what the passport promises.
- Instance-level things that stay global and must NOT gain `space_id`:
  providers, models and keys, users, audit (attribute only), the capability
  registry, trust scores and eval artifacts, budgets and daily caps
  (instance-wide spend protection), and the master key.

## 6. Edge cases not to miss

- **Email intake:** inbound mail must route to a space. Per-alias and
  per-sender routing rules gain a space target; the default is the
  recipient's default space. The UI states this.
- **Connectors:** a connector instance belongs to one space. Connecting the
  same Confluence site into two spaces is two independent connectors,
  allowed by design.
- **MCP and API callers** must carry an explicit space (a parameter or a
  per-token binding); no ambient default for machines.
- **Attention feed and dashboard counts** are per space. Navbar badges
  recompute on switch.
- **Findings reports** are space-scoped by construction (a run enumerates
  sources, which all carry the space); the report scope block states the
  space name.
- **i18n:** every new string (switcher, dialogs, empty states, settings
  copy, confirmations) is a key present in every locale. House style: no
  em dashes.

## 6a. Session 2 decisions (isolation in depth, 2026-08-19)

Recorded with the session that implemented them, the way section 5's
amendments were:

- **The default space is never deletable.** The record requires "not while it
  is the only space"; the implementation refuses it always, which subsumes
  that rule. The default space's fixed id is the instance's resolution
  anchor: the schema-level DEFAULT, the absent-header resolution, the email
  intake target and every CLI principal all name it, so deleting it would
  leave every spaceless caller pointing at nothing. Every other space is
  deletable, content and all, administrator-only.
- **Receipts outlive their space.** A deleted space's receipts ARE the proof
  of its erasure and are immutable, so `deletion_receipt.space_id` keeps the
  column (the chain key) and drops the foreign key (migration 0061). Chain
  verification walks receipts, never the space table, so a deleted space's
  chain keeps verifying standalone. Every OTHER space foreign key stays
  NO ACTION on purpose: the final `DELETE FROM space` refusing while any
  content row remains is the structural completeness proof space deletion
  relies on. Stated precisely (verification F10, wording added by the
  follow-up): that proof covers the POSTGRES half at the instant the row
  deletes. The vector and object halves drain through the same per-source
  receipts and nightly sweep that cover every other deletion, and may still
  be in flight when the row goes; a leg that dead-letters afterwards is
  flagged by the sweep, loudly, like any other pending receipt.
- **Shared material dies with its space.** Scope governs who sees a fact
  WITHIN a space, never whether a fact outlives its space. This is the
  opposite of owner erasure's shared-material rule and deliberately so:
  owner erasure removes one person from a living space, space deletion
  destroys the partition itself.
- **The nightly pass is one job iterating per-(owner, space) groups**, not
  one job per space: partitioning is a grouping concern, not a scheduling
  one. Each group runs in its own transaction under its own per-fact check
  budgets, so a busy space can neither starve a quiet one nor roll back its
  work.
- **The audit space attribute** (section 4's promise) is a nullable
  `audit_log.space_id`, no foreign key, stamped from the principal on request
  paths, from the subject row in worker paths, and via the usage scope for
  model-egress entries. NULL means a genuinely instance-level action, never
  "unknown". Budgets and daily caps stay instance-wide; the usage scope
  carries the space for attribution only, never as a cap input.

## 6b. Session 3 decisions (navigation and the settings split, 2026-08-19)

Recorded with the session that implemented them, the way 6a's were:

- **A space switch is a persisted choice followed by a full page reload** at
  the same path with query parameters dropped (they name objects of the space
  being left). Navigation in the SPA is full page loads already, and a reload
  is the one mechanism that guarantees no query, no badge and no component
  state can ever briefly show the previous space, which the overriding
  constraint values above raw speed. The current space is BOUND once per page
  load before anything renders (the boot gate), and every request carries it
  through one header builder; a failed switch leaves the user where they were
  and says so, and a space deleted in another session is detected by the
  30-second spaces poll and answered with a deliberate dialog, never a
  silently empty view.
- **No unsaved-state prompt, ever.** Unsaved state cannot be detected
  reliably across hand-rolled forms, so per the record's own preference the
  switch never interrupts; the one materially valuable draft (the chat
  composer) survives in sessionStorage PER SPACE and returns when the user
  returns to the space it was typed in.
- **Space settings are reached from the switcher's own menu** (and the space
  is named on the page). The sidebar holds exactly the ten space-scoped
  surfaces and nothing else; a settings entry there would have been an
  eleventh, and the switcher menu is where every other workspace product
  keeps this door.
- **The instance area lives at `/instance/<section>`**, and every legacy path
  (`/providers`, `/models`, `/system`, `/audit`, `/users`) renders the same
  surface and is normalized to the canonical URL, so every pre-existing deep
  link, banner and runbook step keeps resolving. Identity and Sign out live
  in the navbar avatar menu only (owner decision, follow-up to this session):
  the rail is space content plus the version line the runbook's upgrade step
  reads, nothing else, and one identity display beats two. Every settings
  door renders the same toothed cog (one shared icon definition), a bit
  larger in the navbar and turning slightly on hover, because the earlier
  spoked glyph read as a sun.
- **Capture defaults and the auto-research toggle are per user per space**
  (migration 0062): `user_settings` keys on `(user_id, space_id)`, existing
  rows became the default space's rows via the column DEFAULT (migrated,
  never reset), and a missing row reads as the column defaults, which is what
  makes a new space begin with sensible defaults. The settings row's space
  foreign key CASCADES (the `user_space_state` precedent): a preference row
  is per-user state about a space, never content, so it is not part of the
  structural completeness proof that keeps every content foreign key
  NO ACTION. The auto-research toggle moved server-side from per-device
  localStorage, because the record scopes research behaviour to the space and
  a device is not a space.
- **The extraction gate is sealed with its space** (migration 0062): gate
  rows and rules key on `(owner_id, space_id, source_type)`, the pipeline
  chokepoint asks with the SOURCE row's space, and space deletion removes the
  configuration through a new ingestion cleanup leg. This closes the
  foundation session's stated deferral.
- **Email routing stays a default-space affair this session** and the email
  settings surface now SAYS so: the record's table wants it per space, but
  intake has no principal and per-alias space routing is section 6's own
  item. Reported as a code-versus-table disagreement rather than half-fixed.
- **Audit keeps its one instance-level trail** with the session-2 space
  attribute now filterable in the interface; the audit page deliberately
  does not follow the switcher.
- **Terminology:** Croatian says *prostor*, French says *espace*, German
  keeps *Space* (the word German-speaking professionals use, and both
  *Bereich* readings were already taken by scope and by Confluence spaces).

## 6c. Session 4 decisions (the edges and the artifacts, 2026-08-19)

Recorded with the session that implemented them, the way 6a's and 6b's were.
This session covers the paths where content enters or leaves the instance
without a person standing in a space, and the artifacts that carry a space
out of the product. The overriding constraint: no machine and no external
message may ever land in a space by accident. Where a human's current space
is unavailable as context, the space is explicit and recorded, and an
unresolvable space fails loudly rather than defaulting quietly.

### Email intake routing

- **Routing rules are owner-level configuration WITH a space target, never
  per-space rule sets.** Which space's rules govern an inbound message is
  exactly the unknown routing must resolve, so the rules cannot themselves
  live behind it. Every sender allowlist entry now names its target space
  (defaulting to the default space, which preserves prior behaviour
  byte-identically), and a new per-owner **alias rule** maps a plus-addressed
  recipient to a space: mail to `capture+clientx@instance` routes by the
  owner's `clientx` alias rule. One inbound address, tagged, because the
  instance has one mailbox and an alias is an address the sender can be
  given.
- **Resolution order, per recipient, before anything is stored or
  extracted:** an alias in the recipient address wins (the sender named the
  partition explicitly); else the matched sender rule's target, an address
  rule outranking a domain rule (more specific wins, and the unique index
  makes equal-specificity conflicts unrepresentable); else the recipient's
  default space. **The recipient's default space IS the instance default
  space.** The last-used pointer is a UI convenience, and routing mail by it
  would file a client's message wherever the user last happened to browse,
  which is the silent misplacement this session forbids.
- **An alias the recipient has not defined is refused, never defaulted.**
  The sender explicitly targeted a partition; landing that mail anywhere
  else is misplacement. The refusal is recorded in the existing refusal
  ledger (`alias_not_recognized`, owner-attributed, visible on the email
  settings surface) and ingests nothing for that recipient. Recipients are
  independent: one owner's alias rule routing does not depend on another
  owner having one.
- **A routing rule dies with its target space.** The email module's space
  cleanup leg removes alias rules and re-points nothing; a sender rule whose
  target space is erased is removed with it (falling back would put a
  client's mail in the wrong partition, the one forbidden outcome). Mail
  arriving afterwards refuses as `alias_not_recognized` or
  `sender_not_recognized`, legibly and recorded. The rules' space foreign
  keys are the loud mid-erasure backstop.
- The routed space governs the whole copy: the copy's capture scope comes
  from that space's own defaults, and attachment file sources stamp the same
  routed space in the same transaction.

### Connectors belong to a space

- Already true since sessions 1 and 2 and now sealed: the space is chosen at
  creation from the creator's current space and **immutable** (no store
  method writes the column; pinned structurally). Child state (sub-scope
  cursors, the natural-key ledger, sync runs, webhook deliveries, rate
  state) inherits through the connector row, so the ledger's
  `(connector_id, natural_key)` uniqueness needs no space column: a ledger
  key that could straddle spaces would be the bug, not the fix.
- **Credentials are instance-level in storage, space-bound in use.** The
  sealed credential lives in the identity seam with no space column, one
  credential per connector; the connector row carries the space, and every
  use of the credential happens through that row. Connecting the same
  upstream site into two spaces is two authorisations and two entirely
  independent connectors, and the interface says so.
- The store seams that took an OPTIONAL space and fell back to the default
  became REQUIRED parameters: a caller cannot forget the space and silently
  get the default partition.

### Machine callers carry a space

- **A machine principal is a token that resolves without a human profile
  (no email claim).** Human users authenticate through the interface with
  the email scope, so their tokens always carry one; Zitadel service users
  carry none. The one product credential that is a PAT for a human (the
  demo session) therefore stays human, which is correct: it drives the
  interface, which binds the space per page load.
- **Per-credential binding, not a per-request parameter.** A machine has no
  current space and no "most recent" anything, so the space is a property
  of the credential's identity: `machine_space_binding` (spaces-owned,
  administrator-managed, keyed by the machine user id, CASCADE with its
  space). The guard refuses an unbound machine with an error naming the
  binding requirement and the endpoint that satisfies it; a space header
  that disagrees with the binding is refused, never honored, and a header
  that agrees is accepted as a redundant assertion. A deleted space
  cascades the binding away, so the machine is refused loudly instead of
  degrading anywhere.
- **The binding narrows, never widens.** Within its bound space a machine
  caller passes exactly the existing owner, scope and sensitivity gates,
  unchanged.
- **The demo sandbox's one principal is the interface user, not a machine
  caller.** The demo Principal is by construction a Zitadel machine user
  whose PAT the sandbox publishes as the browser session, so in demo mode,
  and only there (the explicit `COGETO_DEMO_MODE=1`, never production), the
  guard exempts exactly the principal the published session file names.
  Every other machine user, the bootstrap PAT included, stays under the
  binding rule even in the sandbox. Found by the rule itself refusing the
  demo seed's own bootstrap, which is the machine wall working.
- There is no MCP server in the product today; the machine-facing surfaces
  are the bearer API (this binding), inbound mail (whose routing rules are
  its binding, above), and connector webhooks (already bound through the
  connector row since session 1). When an MCP server arrives it
  authenticates as a service user and inherits this rule unchanged.
- Humans keep the absent-header resolution to the default space (the
  record's anchor rule, 6a), unchanged.

### Space-scoped artifacts

- **Findings report schema 1.2** (additive): the scope block gains
  `space_id` (required) and `space_name` (nullable, the display name at
  generation time), because a report forwarded to an auditor must say which
  partition it describes. The PDF cover and the provenance table state the
  space. The name resolves through a port the reports module defines and
  the spaces module satisfies (the passport's resolver pattern).
- **The report ledger's remaining cross-space reads are sealed:** the delta
  baseline matches on scope within one space (a first run in a new space
  says "first run" instead of computing a delta against another space's
  run), the single-flight trigger dedupe is per space, and the by-id status
  and download reads carry the caller's space.
- **The attention read state is per (user, space):** `attention_state` keys
  on `(owner_id, space_id)` (CASCADE, the `user_settings` precedent), so
  opening the dashboard in one space no longer silences another space's
  unread indicator, which section 6's "badges recompute on switch" always
  meant. Dismissals gained the space column their key convention already
  encoded; the default space keeps its historical keys byte-identically.
- The passport was made per space in session 1 (format 2.1) and is verified
  here behaviorally: an export contains nothing from another space, and each
  of its receipts verifies individually using only the archive and the
  instance public key (the signature covers the payload including its
  `prev_hash` link). Wording corrected by the verification follow-up (F11):
  a full genesis-to-tip chain walk from the archive alone additionally
  requires that every receipt in the space belongs to the exporting owner,
  since the export carries the owner's receipts and the space's chain
  interleaves every owner's. The precise guarantee is stated in
  [`memory-passport.md`](memory-passport.md) and
  [`../security/deletion-and-receipts.md`](../security/deletion-and-receipts.md),
  which also records that the chain's space PARTITION is a column beside the
  signed payload, not inside it.

## 6d. Wall-holes remediation decisions (2026-08-20)

Recorded with the session that closed the spaces verification's correctness
findings (F1, F2, F3, F6), the way 6a, 6b and 6c were. The three defects
shared one cause: the space could be ABSENT, and absence silently resolved
somewhere. That cause is now a standing constraint:

- **In this feature the space is never optional, never defaulted, and never
  inferred. A path that cannot determine it fails loudly.** No optional
  space field exists for a legacy caller's convenience; no Drizzle column
  default silently supplies one (the DB-level DEFAULT from migrations 0060
  through 0063 remains, as the applied migrations' backfill contract, but no
  compiled write path can reach it); a store parameter is required, not
  defaulted. Where absence is genuinely legitimate it is explicit and
  documented: the audit trail's nullable space attribute (6a), the deletion
  saga's two administrator passes (owner erasure and space erasure, which
  pass an explicit `sealedSpace: null` because they enumerate their set
  upstream), and the mail-intake terminal arm (the recipient default IS the
  instance default, 6c). `spaces-are-a-gate.spec.ts` holds a census of every
  `?? DEFAULT_SPACE_ID` in product code against an allowlist with reasons,
  so a new silent fallback fails a test rather than a customer.
- **Approvals die with their space.** The `approval` table gained the
  agents-owned cleanup leg it was missing (verification F1): a space holding
  any approval row was permanently undeletable, because nothing anywhere
  deletes an approval row. The disposition is DELETION for every approval
  kind, checked kind by kind: a reply draft's payload is content-bearing and
  content dies with its space; a bulk-outdate approval references memories
  that die with the space and carries the requester's free text about them,
  and the decision trail survives regardless in the instance audit log
  (approval.created / approved / rejected / executed, space-attributed).
  Re-homing was rejected: a space's rows appearing in another partition is
  the misplacement this feature forbids. The deletion plan counts approvals,
  so the confirmation states them.
- **The wall has no owner exception, on every branch.** The by-id and
  fallback arms that authorized by owner alone were sealed (verification F3
  and its relatives): the files service's discarded-source and reprocess
  arms, the report assembler's file-scope check, research approve/cancel and
  the web-page read, the project by-id funnel, the memory drawer's mutations
  (sensitive, scope, edit, reject, approve, mark-outdated), chat message
  capture/context and attachment card reads, the reply-draft email read, the
  anchoring context read and edit, extraction-gate rule removal, the skill
  run read, and the interactive source deletion (sealed to the caller's
  space; the administrator passes stay explicitly unsealed). One deliberate
  exception stands as recorded in code: an entity alias is removable by its
  owner from any space, because the id is globally unique and the alias is
  vocabulary configuration, not content.
- **Space deletion enumerates discarded sources from provenance.** The
  session's mandated hand walk found F1's sibling live: a space holding a
  DISCARD-mode file source could never finish deleting, because the
  erasure's enumeration listed adapters' rows and `file_metadata` only, and
  a discarded source has neither: only memories carrying the key as
  provenance. The final row delete refused forever, loudly but with no
  remedy, exactly F1's shape. The pass (and the plan's counts) now add a
  third arm: every distinct provenance pair the space's memory rows still
  name, restricted to object-backed types, the one family whose row can be
  legitimately absent while memories persist. The ordinary saga already
  handles rowless sources; nothing else changed.
- **Suppressed facts land in their source's space** (verification F2): the
  structurally-invalid arm stamps `spaceId` exactly like the demoted arm,
  `SuppressedFactEntry.spaceId` is required, and a behavioural fixture
  ingests into a non-default space and reads the log from both sides of the
  wall. No backfill for misfiled rows was written: there are no production
  instances, so the honest remedy for an affected database is a fresh
  instance, and a backfill would be untestable machinery for data nobody
  holds.

## 6e. Verification follow-up decisions (2026-08-20, session 2)

Recorded with the session that closed the verification's remaining findings,
the way 6a through 6d were:

- **A page restored from the back/forward cache is not a page load** (F4).
  The bind-once rule holds per page load; a bfcache restore resumes the old
  heap with the old binding, so a module-scope guard hides the document in
  the same task a persisted `pageshow` fires and reloads, which re-runs the
  boot gate. Nothing interactive ever exists under a stale binding.
- **Every space change leaves the page through one committed mechanism**
  (F8): persist, cover the page with an opaque status, navigate to a bare
  path, and retry with a reload if the navigation never lands. The switcher,
  create, the deleted-space dialog and the space deletion all use it, so the
  persisted choice and the visible page can never quietly diverge.
- **The instance area renders outside the space boot gate** (F9). It is
  space-independent by design and is exactly what an administrator needs
  when space resolution fails; its shell degrades on its own when the
  spaces list is unavailable. The boot failure screen names the door. The
  instance shell deliberately has no spaces poll and no deleted-space
  dialog: no space can mislead a surface no space owns.
- **A refusal has no space, deliberately** (F13). The email refusal ledger
  records mail that was refused BEFORE a space was resolved; stamping one
  would be an inference, which 6d forbids. The ledger is an owner-scoped
  configuration surface and reads the same in every space. A malformed
  plus-tag now records `alias_not_recognized` rather than
  `wrong_recipient`, because the sender plainly tried to name a partition.
- **GET /api/spaces degrades its pointer against its own list** (F13): the
  list and the last-used pointer resolve in parallel, and a space deleted
  between the two reads now degrades to the default space in the response
  instead of handing the client a current space the list does not contain.
- **`memory_space_idx` earned its keep** (F13): the wall-holes session's
  provenance enumeration (`listDerivedSourceRefsForSpace`) scans `memory`
  by space alone, so the index the verification flagged as unused write
  amplification now serves space deletion's completeness net.
- **The structural gate spec remains a tripwire on the read side,
  deliberately** (F12). The write side gained the census and required-type
  guards in 6d; a read-side PROOF would need SQL introspection the stack
  does not have, and the load-bearing proof remains the adversarial
  behavioural fixture, which runs real stores against real databases.
- The machine-token binding and the upgraded-instance vector recall window
  are documented as outstanding upgrade notes
  ([`../operations/upgrade-notes.md`](../operations/upgrade-notes.md)),
  closing F7 and F5 as documentation: both behaviours are deliberate.

## 7. Decisions and non-goals

Decided by the owner, 2026-08-19:

- **No per-space membership.** Every instance user sees every space.
  Spaces seal content, not people. Within a space, the existing owner and
  scope gates govern who sees a fact, unchanged.
- **No moving a source between spaces.** Not in v1. Re-upload into the
  other space instead. Recorded as a possible future question, not a
  planned feature.
- **No cross-space comparison, ever, by design.** This is not a v1
  limitation; it is the definition of a space.
- **No space-level model configuration.** Providers, models and tiers are
  instance infrastructure.

## 8. Definition of done (beyond the repo standard)

- A single-space instance behaves byte-identically to the product before
  this feature.
- The gate test proves space is a hard dimension in both stores.
- Reconciliation provably never pairs across spaces: an integration test
  with two spaces holding contradictory facts about the same subject yields
  zero findings.
- Switching spaces swaps every sidebar surface and every badge.
- Migration moves all existing data into the default space with no orphans.
- This decision record is frozen before code, following the projects and
  revisions pattern.

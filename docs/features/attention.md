# The attention surface

The dashboard is where you see what is due, open, gone quiet, awaiting approval, and
what changed overnight. In-app only: no mail is sent, and there is no external
dependency.

## The feed is computed, not materialized

A thin derived view assembled per request from signals the instance already produces:
open loops and their dormancy, open contradictions, pending approvals, and the
latest dreaming digest lines.

**No attention-item rows are stored.** Duplicating state that already exists would
create a second source of truth to keep honest. Each item is typed, human-phrased,
timestamped, and deep-linked, with a stable content-free key.

## The only materialized state is read-state

Two tiny per-user tables, co-located with the audit log in `infrastructure` because
the surface spans every bounded context and none owns it:

- `attention_state` (owner, `last_seen_at`)
- `attention_dismissal` (owner, item key, dismissed at)

**Dismissal keys are content-free by construction** (`digest:<run_id>:<index>`, never
memory text), so this durable row never stores content.

## Unread semantics

- **New** means an item whose timestamp, the moment it became relevant, is after
  `last_seen_at`. All such timestamps are in the past, so "new" is honest.
- **Viewing the surface clears it**, not clicking every item. Opening the dashboard
  marks seen and the nav badge drops to zero. The current view keeps its per-item "new"
  highlights so you can see what changed; the next visit reflects the persisted mark.
- **Per-item dismissal exists only where it makes sense.** Digest lines are a discrete
  overnight change and are dismissible. A live count ("3 conflicts to resolve") is **not**:
  it clears when the work is done, not when hidden. The server rejects a dismissal
  whose key is not a digest key.

## Gating is absolute

Every item and every number is Principal-scoped through each module's public
interface, never a raw cross-module table read. The composition lives in the
entrypoints root and reaches memory, agents, and ingestion only through their barrels;
each returns already-gated results.

- The contradiction count is **owner-only**: reconciliation only ever pairs a fact
  with the same owner's memories, so every conflict is yours to resolve. Uncertain
  facts raise no item at all since V2.0 item 3.3: Cogeto resolves those itself, and
  a feed line must be something the reader can actually discharge.
- Open loops are owner-scoped.
- The digest reuses the one gated builder, so an action on a memory the caller cannot
  read simply produces no line. Resolution, not post-filtering. A stranger sees nothing.
- Sensitive content never appears in notification text beyond what the owner may
  already see.

## Statistics are cheap and bounded

The stats endpoint returns counts, grouped counts, and two bounded 30-day series. No
unbounded scan on page load: grouped counts hit indexed columns, each series carries a
window bound, and the dreaming series resolves per-action visibility in memory rather
than through a cross-module SQL join. **The query count is fixed regardless of store
size**, and a test asserts it stays constant and small under ten times the data.

## Due dates are visible, but nothing is pushed

Overdue, due-soon, and gone-quiet items appear here and deep-link to the fact itself,
and a fact's validity interval lives in the memory drawer. What does not exist is the
push: nothing stamps a reminder and nothing renders one in the digest.

A notification layer may return later as its own feature if design partners ask for it.
If it does, it will be built once, for every kind of thing worth notifying about.

## The digest integrates

The dreaming digest is not a separate panel; it is this surface's "last night" group.
The line-building lives in one shared, gated builder that both the digest endpoint and
the feed use, so there is exactly one digest. See [`memory.md`](memory.md).

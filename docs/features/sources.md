# Sources: notes, files, email, web, chat

Everything Cogeto knows points at something. Provenance (`source_type` + `source_id`)
is NOT NULL on every memory row, on every write path, so there are no orphans. A
source type is added by registering a declaration and implementing three ports, never
by forking the pipeline: source types are **registered, not enumerated in a database
type** (spec §15.3). The registry (`project/shared/src/source-types.ts`) declares
every type once with the metadata consumers read instead of switching on literals
(defunct flag, authorship contract, object backing, extraction, fact budget, prompt
label, dashboard family); the columns are plain text since migration 0040 and the
registry boundary validates writes. Full design:
[`module-boundary-contract.md` §6](../module-boundary-contract.md).

| `source_type` | Durable source row |
| --- | --- |
| `note` | the note |
| `file` | `file_metadata`, or none in discard mode |
| `email` | `email_message` |
| `web` | `web_page` |
| `chat` | `chat_message` |
| `chat_conversation` | the conversation, for deletion enumeration only |

`task_conclusion` and `calendar_event` are **defunct**. Deletion receipts citing them
must keep verifying forever, so they stay registered permanently with `defunct: true`.
The binding rule for every reader: *a defunct source type is a known value, never an
unexpected one. No switch may throw on it and no sweep arm may flag it as
unrecognised. It should simply have no rows.* The integrity sweep has an arm proving
exactly that, expected to return nothing forever; since the column became text, the
same arm also flags any value the registry does not know at all, a state only a
manual database write can create.

## The surface: three levels (V2.2 item 5.2)

Sources is the read, audit and resolve surface: where you see and prove what
the system knows, and the surface the findings report (V2.3) renders from.

- **The catalog** (`GET /api/source-catalog`): one row per source of every
  type, with the badges that make the list a scan layer (contradictions,
  superseded, suppressed, truncation, gated, unreadable, processing) and
  filters that drive from each condition's own indexed query. Enumeration is
  cursor-paged per family and merged by date; chat captures and discarded
  originals enumerate from their facts' provenance, because no other durable
  trace of them exists. Badges for a page are grouped queries, never a query
  per row. Name search covers notes, email subjects and page titles; file
  names deliberately live on the object (erased with the bytes), so files are
  found by content.
- **The inspection** (`GET /api/source-catalog/:type/:id`, rendered in the
  source drawer): every fact with its status, its uncertainty sub-reason and
  its exact span shown as located text, the suppressed-fact log beside what
  was kept, the contradictions in context with resolution state, the
  anchoring context, the gate refusal, the read report and the deletion
  action. Owner-only, with ownership resolved structurally per type.
- **Fact detail** (the memory drawer): the whole lifecycle, including the
  verification passage and hedge phrase, the supersession chain, every
  contradiction relation, and which stored answers cited the fact, read from
  their canonical citation tokens.

**Span locators persist at admission** (migration 0046): the pipeline
resolves each admitted or suppressed fact's span to the reader's structured
locators while the segments are still in hand, which is the only moment that
exists for a discard-mode original. NULL means an honest "no location": a
segment-less source, an unfindable span, or a fact admitted before locators
existed (reprocess the source to locate it).

The old flat memories list survives as the **filtered fact search** on
`/memories` (status, sub-reason, entity, content, changed-since), linked from
Sources rather than the navigation rail.

## The three ports

A connector never reaches into ingestion or memory; it implements ports those modules
define, bound at the composition root. This is what keeps the module graph acyclic and
connector tables private.

- **`SourceReader`** loads a source's content for the pipeline, answers
  `existsForAdmission` for the admission checkpoint, and stamps **authorship**:
  whether the content is the user's own words. Notes and captured chat are; a
  document or a fetched page is not; mail is resolved from whether the message
  came from the user's own address. That stamp is what keeps a contract clause
  out of the user's open loops (see [`memory.md`](memory.md)).
- **`SourceDeletion`** deletes the source row inside the saga's enumeration
  transaction, and declares any object keys it owns.
- **`DerivedCascade`** handles derived content the saga must also erase.

## Files

A file enters through one of three doors, and one path (V2.2 items 5.1 and
5.3): the **Sources page** (the deliberate door, for documents you intend to
keep and audit), **bulk import** on the same page (folder, ZIP or S3-style
path: manifest first, nothing ingested until confirmed, every document fed
through the same upload service at demoted queue priority with an in-flight
cap so an import cannot starve the instance, and same-name re-imports
nominated for the conservative revision linker, see
[`revisions.md`](revisions.md); the confirm step also chooses the **memory
scope** for the whole run, private or shared plus the sensitive flag,
prefilled from the saved default and resolved against it server-side when
omitted, exactly the single-upload contract, and the run card reports what it
ingested under), and the **chat paperclip** (the
conversational door, whose endpoint delegates to the same upload service, so
validation, caps, quota, gating and ingestion are identical and only the entry
point and the presentation differ). The Memories tab stopped being an input
surface: it governs what is remembered, and a dismissible pointer says where
capture now lives. A chat attachment additionally records a chat-owned link
row so the conversation can render honest progress and the settled outcome;
see [`conversation.md`](conversation.md). A chat attachment marked "don't
remember this file" is **not a source at all**: its bytes are staged and
deleted after one read, its text serves only its conversation, and it is
erased with that conversation under the same receipt.

Upload mints the object key, PUTs the bytes, then in **one transaction** inserts
`file_metadata` through the memory port and enqueues the pipeline job. If that
transaction aborts, a compensating delete removes the object.

Reading runs through the **reader seam**: PDF, DOCX, XLSX and CSV, selected by the
magic bytes with the declared type and the extension as hints. A parse failure is
permanent and **fabricates nothing**: the reader throws, the job dead-letters, and the
file reads `error`. File jobs cap at 3 attempts, so a corrupt document reaches its
error state promptly while a transient object-store blip still retries. What the
reading layer made of the bytes is recorded on `file_read_report` and shown in the
source drawer, including which of the two failures happened and whether a spreadsheet
was truncated at the row cap. Full design, including the provenance locators and the
spreadsheet flattening rules: [`reading.md`](reading.md).

**Filename and content type live on the object**, not in a new column, as the object's
`Content-Type` and a metadata header. They are therefore **erased with the bytes**, so
no orphaned filename survives a provable deletion. The source drawer reads them back
with a HEAD.

Downloads use a short-lived presigned GET URL, owner-gated: the owner always, a
non-owner only for a shared, non-sensitive file in their org. **A sensitive file never
leaves its owner.** SigV4 binds the signature to the URL's host, so the signing origin
must be an origin the browser can actually reach.

### Extract and discard

With discard mode on, the original bytes are **never durably written and no
`file_metadata` row is created**. No bytes, no pointer. The object key is still minted
and is still the `source_id` of every derived memory, so provenance stays uniform.

The bytes are staged at the key's staging twin, carrying owner, scope, sensitivity and
upload time in the object's own metadata, since there is no row to read them from. The
pipeline reads staging and derives memories with full provenance to the byte-less key.

**Staging cleanup is commit-then-delete.** Deleting inline inside the memory
transaction would lose the extraction if the commit then failed, which is unacceptable
for a verifiable-memory product. So the pipeline **enqueues** the staging delete in the
same transaction as the memories, firing only on commit, with a delayed backstop
enqueued at upload so the bytes go even if extraction never succeeds. Staging keys
never enter `file_metadata`, provenance, or any receipt, so the sweep is blind to them
by construction.

Deleting a discarded source yields a receipt covering the derived memories with an
empty object list. A discarded original still gets a receipt.

## Email

Mail arrives by **forwarding** into a per-tenant, **receive-only** SMTP server that
drops accepted mail onto the ingestion pipeline. Cogeto never holds mailbox
credentials, never reads a whole inbox, and **never sends**. There is no OAuth and no
CASA review.

**Addressing.** Each instance owns one address on its own subdomain,
`capture@in.<instance>.cogeto.eu`. The tenant is encoded in the **subdomain**, never in
a shared central domain: a shared relay fanning mail out to tenants would put every
tenant's mail through shared infrastructure, defeating the isolation that is the whole
security argument. A fresh instance with no configured address rejects all recipients.

**Routing is by sender.** For each message accepted at the recipient and size gates:

1. A sender matching a **registered user's own email** is captured for that user. Every
   user's own address is implicitly trusted, which covers manual forwards and BCC with
   zero configuration.
2. Otherwise, **every user whose personal allowlist matches the sender** receives their
   own copy. The allowlist means *senders whose mail I want in my memory*, which is the
   provider-side auto-forward case. Multi-match is copy-to-each by design: each matching
   user explicitly opted into that sender.
3. Nobody matches, so it is **refused**, closed by default. The refusal row carries no
   owner and appears in every user's "recently refused", so any user can claim the
   sender in one click.

**The operator's bootstrap admin never captures.** A customer who should also operate
gets the admin *role*, not the admin *user*.

Matching normalizes to `local@domain`, using the envelope sender where available and
falling back to the header `From` when it is empty. Allowlist entries are exact
addresses or whole domains; **subdomains are not implicitly included**, which keeps the
gate predictable.

**The spoofing stance, stated deliberately.** In a forwarding model the envelope sender
and header `From` can both be forged, so sender routing is an **acceptance-scoping**
control, not authentication. Someone who knows a user's address can inject a memory into
that user's account. This is defensible because per-tenant isolation bounds the blast
radius to memory the tenant already chose to trust. SPF and DKIM verification remain
documented later hardening. See
[`../security/inbound-email-anti-spoofing.md`](../security/inbound-email-anti-spoofing.md).

**Enforcement is authoritative in the app, surfaced at SMTP.** The SMTP server's queue
hook calls the intake over an internal authenticated endpoint and translates the verdict
into the SMTP response, so a sending server gets a clear refusal during the transaction
while acceptance logic stays in one unit-tested place. Cheap pre-filters (recipient,
size, rate) still run before the app is called. **A refused message stores nothing**:
only a metadata-only refusal row with sender, time, and reason.

**Full retention is deliberate.** Every accepted message is stored complete: parsed
headers, plain-text body, sanitised HTML, attachments, and the raw original in the
encrypted bucket. The display HTML is sanitised by an HTML **parser** against an
explicit allowlist, and the drawer renders it inside a sandboxed frame that cannot
execute script or reach the session; the raw original is kept byte-exact regardless. Extraction is one *consumer* of the message, not the point of storage;
retaining the whole thing lets later features derive more value without asking the user
to forward again. The corpus respects scope and sensitivity like any source, and carries
the same deletion and export guarantees.

Intake follows the same object-first safe order as file upload, and supported
attachments become their own linked file sources in the document pipeline. Unsupported
attachments are recorded but not processed; their bytes remain inside the retained
original.

Anti-abuse hygiene underneath the routing gate: message and attachment size caps,
recipient validation, per-connection concurrency, and per-host rate limits. These are
hygiene, not a full anti-spam stack; content scoring, greylisting, and RBL checks are
deliberately absent, because sender routing makes them redundant for acceptance.

## Notes, chat, and web

**Notes** are the simplest source: content plus a capture-time scope, straight into the
pipeline.

**Chat** capture is explicit only, and assistant messages are never captured. See
[`conversation.md`](conversation.md).

**Web** pages are covered in [`web-research.md`](web-research.md).

## Deletion covers all of them

Every source type is erased by the same saga, enumerated by provenance, with one signed
receipt. Nothing about a source type changes the deletion contract. See
[`../security/deletion-and-receipts.md`](../security/deletion-and-receipts.md).

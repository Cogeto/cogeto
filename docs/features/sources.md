# Sources: notes, files, email, web, chat

Everything Cogeto knows points at something. Provenance (`source_type` + `source_id`)
is NOT NULL on every memory row, on every write path, so there are no orphans. A
source type is added by implementing three ports, never by forking the pipeline.

| `source_type` | Durable source row |
| --- | --- |
| `note` | the note |
| `file` | `file_metadata`, or none in discard mode |
| `email` | `email_message` |
| `web` | `web_page` |
| `chat` | `chat_message` |
| `chat_conversation` | the conversation, for deletion enumeration only |

`task_conclusion` and `calendar_event` are **defunct**. Postgres cannot remove a value
from an enum, so they remain in `source_type` forever. The binding rule for every
reader: *a defunct source type is a known value, never an unexpected one. No switch
may throw on it and no sweep arm may flag it as unrecognised. It should simply have no
rows.* The integrity sweep has an arm proving exactly that, expected to return nothing
forever.

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

Upload mints the object key, PUTs the bytes, then in **one transaction** inserts
`file_metadata` through the memory port and enqueues the pipeline job. If that
transaction aborts, a compensating delete removes the object.

PDF and DOCX extraction runs on the resolved content type. A parse failure is
permanent and **fabricates nothing**: the extractor throws, the job dead-letters, and
the file reads `error`. File jobs cap at 3 attempts, so a corrupt document reaches its
error state promptly while a transient object-store blip still retries.

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
encrypted bucket. Extraction is one *consumer* of the message, not the point of storage;
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

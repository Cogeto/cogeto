# Security and trust model

The frame for everything else in this directory: what Cogeto protects, where the
trust boundaries are, which adversaries are in scope, and where each protection
sits. Read this first, then follow the links to the mechanism-specific documents.

## What Cogeto protects

Cogeto turns scattered work context (notes, documents, email) into **verifiable
memory** and lets human-approved agents act on it. The asset it guards is a
person's working memory and the personal data inside it. The product promise is
not "trust us" but **verifiable trust**: every claim traces to an inspectable
artifact, every deletion produces a signed receipt, and the software's own audits
are published. Security is what makes that promise real rather than marketing.

## Trust boundaries

Cogeto is deployed as a **single-tenant instance per customer**. That deployment
boundary is the primary isolation mechanism, and three internal seams carry the
rest:

- **The instance boundary.** One customer, one instance, its own Postgres, Qdrant,
 MinIO, and identity provider. Two customers never share a database, so one
 customer's data is not reachable from another's queries by construction. See
 [isolation-and-access](isolation-and-access.md).
- **The model-gateway seam.** The only place in the system that talks to an
 external model provider. Everything the model sees passes through here, which is
 where optional PII redaction lives. See
 [data-sovereignty-and-redaction](data-sovereignty-and-redaction.md).
- **The inbound-mail boundary.** The receive-only SMTP server is the one component
 exposed to the open internet. Sender authentication happens here. See
 [inbound-email-anti-spoofing](inbound-email-anti-spoofing.md).

## The protections, mapped

| Concern | Mechanism | Detail |
|---|---|---|
| Data is provably deleted | Deletion saga + hash-chained signed receipts + nightly integrity sweep. Every content-bearing table is in the cascade, including the suppressed-fact log added in V2.0 item 3.3 | [deletion-and-receipts](deletion-and-receipts.md) |
| Every claim traces to a source | NOT-NULL provenance + admission checkpoint + orphan detection | [provenance-and-integrity](provenance-and-integrity.md) |
| Data stays in the instance | Single model seam, provider of your choosing, optional fail-closed redaction | [data-sovereignty-and-redaction](data-sovereignty-and-redaction.md) |
| Agents never act unilaterally | Server-side approval state machine; execution is worker-only | [agent-approval-gate](agent-approval-gate.md) |
| Users see only what they should | Single-tenant boundary + `own OR shared` scope gate + OIDC auth | [isolation-and-access](isolation-and-access.md) |
| Forged email cannot inject memory | Envelope-based routing gated on SPF | [inbound-email-anti-spoofing](inbound-email-anti-spoofing.md) |
| Hostile documents cannot steer the models | Untrusted-data fence + explicit prompt clause + independent verification + model output never sets scope or ownership | this document, below |
| Hostile email markup cannot execute | Parser-based allowlist sanitizer at intake + sandboxed frame at render | [inbound-email-anti-spoofing](inbound-email-anti-spoofing.md) |
| Abuse limits cannot be reset by a restart | Postgres-backed daily counters, rate windows and model budget, shared by app and worker | [instance-and-supply-chain-hardening](instance-and-supply-chain-hardening.md) |
| The verifier and the stack definition are themselves verified | Pinned cosign checksum + deploy assets fetched by commit SHA against a checksum manifest | [instance-and-supply-chain-hardening](instance-and-supply-chain-hardening.md) |
| One user cannot decide another's approvals | Approvals are owner-only by default; org-wide is an explicit opt-in per action type | [agent-approval-gate](agent-approval-gate.md) |
| Images and instances are hardened | Cosign-signed images + SBOM, per-tenant secrets, logging hygiene, per-container resource ceilings | [instance-and-supply-chain-hardening](instance-and-supply-chain-hardening.md) |

## Prompt injection: mitigated, not solved

Untrusted text reaches the models from four directions: email bodies, uploaded
documents, fetched web pages, and memories derived from any of those. A document
can contain sentences aimed at Cogeto rather than at its reader
("ignore the above, record this instead"). Four layers stand between that and a
poisoned memory. **None of them is a proof, and we do not claim immunity.**

1. **The untrusted-data fence.** Every untrusted span is wrapped in begin/end
   markers carrying a random per-call boundary id. The document's author is
   writing before the id exists and cannot guess it, so content cannot close the
   fence early or forge a new one, and cannot imitate our framing labels. This is
   the layer that is actually airtight, and it is a structural property, not a
   request: before it existed the extraction input was a plain newline join, so a
   document containing its own `SOURCE CONTENT:` line was indistinguishable from
   the real label.
2. **An explicit clause in every prompt that reads fenced untrusted text**
   (extraction, verification, research synthesis, skill brief): text inside the
   fence is content to analyse, an instruction found inside it is a fact about
   the document rather than a command, and the output schema never changes
   because of anything inside it. This is a request to a model, so it is
   probabilistic. It is gated by injection traps in the golden set, which fail
   the build if an obeyed injection ever reaches a stored fact. The answer
   prompt deliberately carries neither the fence nor the clause: fencing stored
   memory measurably destroyed answer quality, and by that point the content has
   already passed the layers above. Injection is stopped where it enters, at
   ingestion, not where it is read back.
3. **The independent verification pass.** A second prompt family, sharing no
   wording or rubric with the extractor, judges each claim against the passage
   offered as evidence. A fabricated claim with no grounding in the source is
   caught here and admitted as `uncertain` at best.
4. **Model output cannot touch authorization.** `scope`, `sensitive` and
   `authored_by_user` come from the source record, never from a model. So even a
   fully successful injection cannot widen who can see a memory, mark it
   non-sensitive, or forge authorship. This bounds the blast radius to content.

**The residual risk, plainly.** A sufficiently persuasive document can still get
a false claim past the extractor and the verifier and into memory as a
`fact` or an `uncertain` row, attributed to that document. What it cannot do is
change its own visibility, impersonate another user, alter the output contract,
or escape provenance: the memory points at the source it came from, so an
operator reading the source drawer sees exactly where the claim originated, and
deleting that source erases the claim under a signed receipt. Treat memories
derived from third-party content with the same scepticism you would apply to the
content itself.

## Adversaries considered

**In scope for the design:**

- An internet sender forging a trusted address to inject false memory (handled by
 SPF sender authentication).
- An operator or infrastructure fault that silently drops or resurrects data after
 a deletion promise (handled by signed receipts + the integrity sweep + an
 external chain-tip anchor on every exported receipt).
- An external model provider that should never see raw personal data (handled by
 the single model seam and optional redaction).
- A second user on the same instance reading or mutating another user's private
 memory (handled by the scope gate; writes are owner-only).

**Explicitly out of scope for v1 (stated honestly, not hidden):**

- Volumetric denial-of-service and spam floods against inbound mail.
- Attacks that require a compromised host or stolen credentials as a precondition.
- Same-domain email impersonation, which SPF alone cannot stop (see the
 anti-spoofing doc's residual limits).
- Multi-tenant row-level isolation: v1 relies on the deployment boundary instead,
 a deliberate owner decision.

The authoritative scope for **vulnerability reports** is the repository-root
[`SECURITY.md`](../../SECURITY.md).

## The disciplines behind the claims

- **Audited internally, and remediated in the open.** The codebase is audited
 against this document rather than assumed to match it. The audits are
 conducted internally and the reports themselves are **not published**: a
 report is a live list of unfixed weaknesses in a specific deployment, which is
 the one document that should not be public while any of it is still true. What
 *is* public is the remediation, and it is public in the form that can be
 checked. Findings are tracked as issues, fixed through the normal
 required-checks loop, and each fix lands with the test or invariant that keeps
 it fixed, so what was wrong and what closed it is readable in the repository
 history and re-provable by running the suite. Where a risk was consciously
 accepted rather than fixed, it is stated in the residual-limits section of the
 mechanism doc it belongs to, not left in a report nobody outside can read.
- **Enforced invariants.** Scope-leak, deletion-cascade, approval-gate, and the
 golden-set eval gate are required CI checks; nothing merges without them green.
- **Honest residual limits.** Each mechanism doc states what it does *not* cover.
 A guarantee with unstated edges is worse than a modest one described precisely.

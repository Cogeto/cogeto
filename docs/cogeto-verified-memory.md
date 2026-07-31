# Cogeto Verified Memory

This document describes what Cogeto stores, what it guarantees about it, and how each guarantee is enforced. It is written to be checked rather than believed.

---

## 1. The unit of memory is a claim

Cogeto does not store documents and hand back fragments of them. It stores atomic claims. One claim is one record, and it carries everything needed to judge it:

| Field | Meaning |
|---|---|
| `claim` | One assertion in natural language, small enough to be true or false on its own |
| `kind` | fact, decision, preference, commitment, or open loop |
| `subject_entity` | What the claim is about, resolved with the document's anchored subject rather than whatever the sentence happened to name |
| `entities` | Other named things the claim mentions |
| `source_span` | The verbatim excerpt of the source that supports the claim |
| `source_type`, `source_id` | The document, note, message or page it came from |
| `owner_id`, `scope`, `sensitive` | Who owns it, who may see it, how carefully it is surfaced |
| `status` | Its position in the lifecycle |
| `valid_from`, `valid_until` | The period over which the claim is asserted to hold |
| verification verdict and span | The independent judgement recorded when it was admitted |

The span is the important field. It is not a page reference or a similarity score; it is the text itself. Any answer that cites a fact can be followed back to the sentence that produced it in two steps.

---

## 2. Verification before storage

The write path is a gate. After extraction, a second and independent prompt family re reads **only the claim's own source span plus approximately 240 characters of surrounding context** and judges whether that evidence supports the claim. It is deliberately not given the whole document, so it judges evidence rather than repeating the extraction.

| Verdict | Outcome |
|---|---|
| Supported, and the claim was not hedged in the source | Stored as `active` |
| Supported, but hedged in the source | Stored as `uncertain`, reason: hedged in source |
| Partial | Stored as `uncertain`, reason: partially supported |
| Unsupported | Stored as `uncertain`, reason: unsupported, and excluded from confident answers |
| Missing from a batched reply, or the cited span could not be located in the source | Stored as `uncertain`, reason: unjudgeable |
| A blank claim, or a claim with no source passage at all | Not stored. Recorded in full in the suppressed fact log |

Failure never defaults to acceptance. A claim the verifier cannot judge is demoted, not admitted.

The reasons are a frozen vocabulary and the mapping is total: every outcome lands on exactly one of them, and there is no default arm for an outcome nobody anticipated.

Cogeto resolves these outcomes itself. There is no approval queue and no list of items waiting for a human, and no ingestion ever pauses for one. A fact is demoted rather than discarded wherever demotion is honest, because a stored fact is inspectable in Sources and citable with soft framing while a discarded one would exist only in a log. The single exception is the last row above, where storing would be storing nothing: a memory with no content, or a fact with no provenance to inspect.

Every demotion **and** every non-admission writes a **suppressed fact log** entry recording the fact as extracted, its source, its exact span, the reason, the verification detail behind the decision and the time. That log is gated exactly as memories are, queryable by source, reason and date range, appears on the source detail, and is summarized in the findings report, so what the system rejected is as inspectable as what it kept. Its entries live for the life of their source and are erased with it under the same signed receipt.

You can still confirm a fact yourself, and your confirmation outranks the machine's judgment from then on. It is an action on the fact, where its evidence is in front of you, not a queue to work through.

This is what prevents the common failure of document assistants, in which a model's misreading is stored once and then repeated back with confidence forever.

---

## 3. Provenance and honesty in answers

Every fact carries the text that produced it. Every answer marks each claim as either cited to a memory or **unsourced**, meaning it came from the model's own knowledge rather than from the corpus.

When a question finds nothing relevant, the answer says so plainly and puts any general knowledge that follows under a banner marking it as not from the user's sources. When a question is ambiguous across several subjects the corpus holds, the answer fans out across them with a citation and a verdict for each, and asks which was meant. When a cited fact is in conflict with another, the answer carries the warning.

There is no configuration for any of this. Cogeto has one behavior, and there is no mode in which model knowledge is presented as if it came from the customer's documents.

---

## 4. The lifecycle

| Status | Meaning | Set by |
|---|---|---|
| `active` | Verified, current, retrievable at full weight | The write path |
| `uncertain` | Failed or partial verification, or hedged in source. Demoted and excluded from confident answers | The write path |
| `contradicted` | In conflict with another fact, both sides linked | Reconciliation only |
| `user_approved` | Confirmed by a person. Never merged away | The user |
| `outdated` | Its validity period has passed | The nightly pass |
| `replaced` | Superseded by a later fact, with the chain preserved | Reconciliation, merge or edit |

Retrieval weights, applied after the access gates: active and user approved at 1.0, uncertain at 0.6, contradicted at 0.4 with a visible warning, outdated at 0.2, replaced at 0.

Nothing is deleted as a side effect of these transitions. A superseded fact stays readable together with the chain that replaced it, which is what makes it possible to ask what the organization believed at an earlier date and what changed it.

---

## 5. Who may see a fact

Access is enforced inside the query, in both stores, and never applied to results after fetching. An unscoped read is not expressible in the retrieval path.

**Scope** is `private` or `shared` and decides who may see a fact. The **sensitive** flag is an orthogonal axis deciding how carefully a fact is surfaced. Both are hard gates rather than ranking adjustments, and any combination of the two is valid: a shared fact can be sensitive, a private fact can be ordinary.

Scope is a permission, not a judgement, so Cogeto never infers it from content. It comes from an explicit choice, from a rule someone wrote, or from a system that already knows:

| Entry point | Rule |
|---|---|
| Upload | Explicit choice, defaulting to the user's setting |
| Chat capture | Private, stamped explicitly |
| Mail intake | The recipient's default, with per sender and per alias routing rules for recurring flows |
| Connectors | Inherited from the source system. A team readable space is shared, a personal or individually restricted item is private to that user, and an item restricted to a subset of people is skipped and reported in the sync summary |

Scope and sensitivity are editable per source and per fact. A change re stamps the affected facts in both stores and writes an audit entry. Raising a fact from private to shared also admits it to the shared reconciliation pool, so conflicts with shared material can surface afterwards.

---

## 6. What happens when two facts meet

Candidate selection is deterministic and model free. Only pairs that survive it cost a model call.

**Deduplication runs first.** Near identical claims of the same kind are judged same fact, distinct or related. On same fact, one record survives, a user approved fact is never the one discarded, and the loser becomes `replaced` with a supersession pointer while its validity interval closes.

**Contradiction runs second.** Pairs in the similarity band, including those deduplication marked related, are compared once their subjects have been resolved through aliases, typos and cross language names, so "Adriatic Foods" and "Jadranske hrane" are recognized as the same subject. Numeric and unit comparison runs deterministically before the judge is consulted, so 3.2 mm against 3.4 mm, or fifty thousand against 50,000, is caught by arithmetic rather than left to a model's discretion. The judge returns contradicts, compatible or supersedes.

On **contradicts**, both facts become `contradicted` and are linked by a permanent relation carrying both spans, both sources and the detection date. On **supersedes**, the earlier fact is closed only when the winner is also temporally later; where the model's verdict and the timeline disagree, the pair becomes a human facing contradiction instead of a silent rewrite. At most one action is taken per fact per pass, so one ingestion cannot cascade through the corpus.

**Compatible verdicts are persisted** in a checked pair ledger. A pair judged compatible is not asked again unless one of its facts changes, so a borderline pair cannot drift into a conflict from model variance, and the corpus becomes cheaper to maintain as it grows.

Similarity thresholds are calibrated for the embedding model in use and versioned with the reconciliation configuration, because the same numeric threshold means different things under different embedders.

**Contradictions are surfaced, never queued.** They appear on the source, in any answer that cites either side, and in the report. There is no chore list, because a product that generates homework does not get used.

---

## 7. Time

Validity is modelled as a half open interval, and the predicate that tests it exists in exactly one place, in a pure form and an SQL form, verified against a truth table.

A fact's validity begins when it is admitted, or at the date its source asserts. It ends when a later fact supersedes it, when a merge or an edit closes it, or when a stated end date passes and the nightly pass marks it outdated. Relative expressions in source text ("last quarter", "since March") are resolved deterministically against the source's reference time in the instance or user timezone; expressions that cannot be resolved are flagged rather than guessed.

Three temporal reads are available and always explicit rather than inferred from phrasing: what was believed at a point in time, what changed since a date, and what the previous version of a fact was. This is the mechanism behind questions like what the documentation asserted when a customer placed an order, and which change replaced it.

---

## 8. Artifacts a third party can check

| Artifact | What it guarantees |
|---|---|
| **Deletion receipt** | An ed25519 signature over a canonical record of what was deleted, hash chained to its predecessor, verifiable without trusting the instance. Deletion itself runs as a saga across the database, the vector index and object storage |
| **Integrity sweep** | Nightly detection of orphans and tampering across the three stores. It reports and never repairs, because self healing is indistinguishable from evidence destruction |
| **Memory Passport** | A signed, complete export in an open, documented format. Leaving is a supported operation rather than a negotiation |
| **Audit log** | Append only, enforced by a database trigger, written in the same transaction as the action it records, covering reads as well as writes, with a retention policy and an export path |
| **Findings report** | A signed, printable record of a defined corpus scope: every contradiction with both claims, both verbatim spans, document with revision and location, detection date and resolution status; superseded chains; and the suppressed fact summary. PDF for people, JSON for machines, signed through the receipt path |

A report is always produced over an explicitly selected set of sources, so the signature covers something defined. Findings where one side lies outside that scope appear in a separately labelled boundary section, because a reader must know when a referenced document was not part of the audited set.

---

## 9. Measurement

Cogeto measures itself against a labelled golden corpus in English and Croatian, covering extraction precision and recall, verification agreement, deduplication accuracy, contradiction precision and recall, supersession, anchoring, ambiguity handling and query rewriting, plus a vertical set drawn from real regulatory and requirements documents and pairs covering numeric, unit and cross language conflicts.

Three rules govern this:

1. **Floors apply per language.** A weaker language cannot be masked inside an aggregate.
2. **Scores belong to a model configuration.** Changing the extraction or verification model produces a different score set, which is why the administration page shows the measured quality of each configuration and flags untested combinations.
3. **Publication includes the unflattering numbers.** Every release publishes its scores, gates ratchet upward, and a drop beyond two points requires a recorded decision.

Trust scores travel with the findings report, so the artifact a customer forwards states the measured accuracy of the system that produced it.

---

## 10. Where the guarantees end

These are properties of the design, stated so nobody has to discover them.

**Verification is a measured judgement, not a proof.** The verifier is an independent model whose agreement with human labels is published. It can demote a claim that was true. The suppressed fact log exists so that this is visible rather than silent.

**Quality is not uniform across languages.** Extraction and reconciliation are measured separately per language and the numbers are published. Interface language support is not the same thing as extraction quality, and the trust page distinguishes them.

**One instance is one trust domain.** Isolation between customers is a deployment boundary. Inside an instance, scope and sensitivity govern access; between instances, nothing is shared at all.

**Cogeto knows only what was recorded.** It does not capture undocumented judgement, and it says that a question is unanswered rather than filling the gap.

**Cogeto reasons over retrieved facts.** It is briefed rather than clever, and it does not replace a general assistant for open ended thinking.

**Customer knowledge is never training data.** Facts stay in the customer's instance. Nothing is trained on them, which is precisely why any of them can be cited, corrected, superseded and deleted with a receipt.

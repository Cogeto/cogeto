# Cogeto Scope

## 1. Position

Models are rented; knowledge is owned.

The value in AI is splitting in two. Models, the reasoning, are becoming a commodity: rented, replaceable, improving every quarter, the same for you as for your competitor. What is not a commodity, and never will be, is what your organization knows: the decisions, the measurements, the failures, the corrections, the ten years of "we tried that and here is what happened". Today that knowledge lives scattered in documents that silently contradict each other, in threads nobody rereads, and in the heads of people who will eventually leave.

Cogeto is the system that turns that scattered material into an owned asset: every claim extracted with its source, verified before it is stored, checked against everything else you know, tracked as it changes, and provable to anyone who asks. The model on top can be swapped as better ones arrive; the knowledge underneath compounds and stays yours. An expert, it turns out, is mostly a body of verified knowledge plus the ability to read it. The reading is now cheap, and Cogeto is where the knowledge lives.

This is not a promise that Cogeto makes AI smarter. It does not. It makes AI briefed: on your facts, with citations, honestly silent where your records are silent. It will not capture what your people never wrote down, it will not out reason a frontier model, and it cannot substitute for the discipline of recording what you learn. What it does is lower the cost of that discipline to almost nothing, a forwarded email, a photographed note, one typed line, and guarantee that what goes in stays true, current, and checkable for as long as you exist.

The bet, stated plainly: organizations that treat their knowledge as infrastructure will outperform those that rent intelligence and remember nothing. Cogeto is built for that bet. It is infrastructure for institutional memory: model agnostic, self hosted if you need it, verifiable because trust that cannot be checked is not trust.

**One sentence:** Cogeto audits your documents, then chats with what survived.

---

## 2. What the product does

Point Cogeto at a set of documents. It reads all of them, including scans and spreadsheets, anchors every fact to its subject and its exact span, detects contradictions and supersessions across the whole set, and produces a signed printable findings report that an auditor or a quality lead can forward. Then it answers questions over what survived, with citations, warnings where sources conflict, and honest silence where the corpus has nothing to say.

Two deliverables, in that order:

**The findings report.** A forwardable artifact: every contradiction with both claims, both verbatim source spans, the document, revision and location of each, the date it was detected, and its resolution status; superseded facts with their chains; and a summary of what the system rejected during verification. Signed, so a third party can check it.

**Verified chat.** Every answer cites the fact it rests on, every fact points to the sentence it came from, contradicted material is flagged in the answer, and knowledge that came from the model rather than the corpus is marked as such.

---

## 3. Who it is for

| Buyer | Situation | What they get |
|---|---|---|
| Quality and regulatory leads in regulated mid size firms, medical device technical files first, automotive and engineering requirements second | A scheduled audit, a revision cycle, a technical file that four years and several people have edited | The findings report before the audit, then continuous conflict detection on every new revision |
| Organizations that must keep documents inside their own network | Data residency, air gap, or a security review that a hosted assistant cannot pass | Verified answers and signed artifacts, running fully offline |
| Professionals and small teams carrying years of client context | Knowledge scattered across mail, files and notes, one instance per client | Accumulated verified memory that survives staff turnover and time |

---

## 4. In scope

1. Reading every document that arrives: PDF, DOCX, spreadsheets, mail, notes, chat capture, scans through local recognition, hard scans through a local vision model, and connected systems. A file that cannot be read is labelled unreadable rather than reported as processed.
2. Extracting atomic claims with exact provenance, anchored to the document's subject, class and revision.
3. Verifying every claim against its own source span before storing it, handling the failures automatically and logging them.
4. Reconciling the corpus: deduplication, supersession, and contradiction detection with detection dates.
5. Tracking validity over time, including what was believed at a past date and what changed since.
6. Answering with per claim citations, conflict warnings, fan out on ambiguity, and explicit silence where the corpus is silent.
7. Proving it: signed findings report, signed complete export, hash chained deletion receipts, nightly integrity checking, append only audit log.
8. Publishing measured trust scores per release and per model configuration, including the unflattering ones.
9. Running entirely inside the customer's boundary, including fully offline.

---

## 5. Out of scope

| Not this | Reason |
|---|---|
| A task or workflow tracker | Open loops live as memory kinds and validity dates. Cogeto records what is known, not what is assigned |
| A reminder or notification product | Due dates are visible where the knowledge is; scheduling people is a different product |
| A manual review queue | Cogeto resolves its own reviews. A product that generates homework does not get used |
| A general purpose assistant | Cogeto reasons over retrieved facts. For open ended thinking, drafting and breadth, a frontier assistant is the right tool |
| An agent framework or an agent memory library | Different shape, different buyer. Cogeto is single tenant, write gated and interface first |
| A manufacturing execution or shop floor dispatch system | Cogeto is the verified source of the instruction, not the tracker of who performed it |
| A connector hub | Connectors bring documents in. They are chosen by customer demand, never counted as a competitive score |
| Per project memory isolation | Projects organize conversations, files and research. Memory stays one connected pool, because conflicts between projects are exactly the findings worth having |
| Multi tenant shared storage | Isolation is a deployment boundary, which is also what makes the verification and offline story hold |
| Training models on customer knowledge | Fine tuning teaches style, not reliable facts, and it destroys provenance, updating, deletion and access control. Knowledge lives in the store |
| Inferring access from content | Scope is a permission, not a judgement. It comes from a person, a rule, or a source system that already knows |

---

## 6. Where Cogeto sits among adjacent products

**Enterprise search and retrieval assistants** share the chat surface and the sentence "AI that answers from our documents". They retrieve and cite passages. They do not verify a claim before storing it, do not detect contradictions across a corpus, do not model validity over time, and do not publish measured accuracy. Cogeto competes on knowledge integrity, not on connector count.

**Self hosted open source AI platforms** share the deployment posture and the licensing. The distinction is the same, plus the artifact: they produce conversations, Cogeto produces a signed findings document.

**Vertical document analysis tools** for requirements, contracts and regulatory files own a workflow and analyze within one silo. Cogeto finds conflicts between silos: the specification against the mail against the minutes against the scan. It sits beside those tools rather than replacing them.

**Frontier assistants** are readers with amnesia: excellent in context, gone tomorrow, sampled rather than systematic, unable to cite a span, and unable to enter a closed network. Cogeto is a ledger with a reader attached. The two are different instruments, and Cogeto's documentation says so.

---

## 7. Principles

1. **Cogeto decides what it can measure.** Support, contradiction, validity, ambiguity. It does not guess at permissions or intent.
2. **One behavior, not a settings page.** Where a choice would create two products, the system picks one and states it.
3. **Chat is the door; Sources is the proof.** Knowledge enters through conversation; Sources is where it is inspected and proven.
4. **Contradictions are surfaced, never queued.**
5. **Nothing enters unverified, and nothing is dropped without a record.**
6. **Published measurements include the unflattering ones.**
7. **The customer's knowledge is never the vendor's asset.** Cogeto sells the vault, the verification and the proof, never the contents.

---

## 8. Licensing and delivery

Cogeto is open source under AGPLv3, with a commercial licence for organizations that need one. It is delivered as one container image with its supporting services, one deployment per customer, running in the vendor's hosting, the customer's cloud, or entirely offline inside a closed network.

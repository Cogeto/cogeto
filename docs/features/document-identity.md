# Document identity: how a commercial document's facts hang together

Frozen before code, the revisions.md discipline. Issue #498.

## The problem, from the evidence

From one real invoice (020260455), six admitted facts carried three subject
views: issuance under the seller (Nexen Europe Group BV), payment terms under
the buyer (ET Systems Engineering d.o.o.), and the total, line items, shipping
and VAT exemption under NO subject at all. Per-subject clustering can then
never assemble the invoice: asking for the due date of the Nexen invoice
honestly answers that nothing is on record under Nexen, while NET 60 DAYS sits
under the buyer and the 9666 EUR total under nobody. The key a human uses, the
document identifier, is present in most of the fact texts and is never a
subject.

## The decision

**A commercial document's identifier is a subject in its own right, filled
deterministically at admission for facts that would otherwise have none.**

- At stage-5 admission, a fact whose `subject_entity` is null and whose claim
  carries a commercial document identifier (a document word followed by a
  numbered token: invoice, offer, order, quotation, delivery note, ponuda,
  račun, račun-otpremnica, narudžba) takes that identifier, verbatim from the
  claim, as its subject. Extraction prompt v0006 anchors every line-item claim
  to the identifier, so the identifier is reliably present exactly where the
  subject is reliably absent.
- Facts that HAVE a subject keep it untouched: the seller's issuance stays
  under the seller, the buyer's terms under the buyer. This rule only fills
  nulls, never overrides a model- or anchor-resolved subject, which keeps it
  inside the spec 1.5.2 posture that mechanical resolution may only reduce
  ambiguity.
- The rule is code, not model: a pure function with a fixed vocabulary, tested
  in both corpus languages. No prompt changes, no new tables, no migration.

## What this buys, and the stated limit

With the identifier as a subject, the ambiguity clustering assembles the
document's own facts under one key, and the raw-text naming tier (config v3,
issue #497) resolves "what is the total of invoice 020260455" to that cluster
deterministically. **The limit:** party-name assembly stays split. Asking
about "the Nexen invoice" still reaches only the facts under Nexen plus
whatever the identifier cluster shares through entities; unifying a party
with a document identifier is a semantic identity claim this rule refuses to
guess. The existing `entity_alias` surface (Settings, V2.3 item 6.1) is the
deliberate manual path: recording "Invoice 020260455" as an alias of "Nexen
Europe Group BV" merges the clusters today, per user, with an audit trail.
An automatic party-to-identifier link stays out until evidence shows a safe
rule; that evidence gathering is the follow-up recorded on issue #498.

## Non-goals

No retroactive rewrite of stored subjects (a reprocess re-admits and the rule
applies then); no new gate (the subject zero-tolerance gate already covers
declared subjects, and the golden line-item cases deliberately declare none);
no cross-document identity (revision linking owns that, revisions.md).

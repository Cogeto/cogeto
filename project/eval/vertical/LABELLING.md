# Labelling rules for the vertical corpus

*V2.3 item 6.4, issue B. Written **before** the first label, which is the point:
labelling is the hard part and the value of the whole exercise, and a rule
invented while looking at a disagreement is a rationalisation, not a rule.
A future labeller who follows this file will be consistent with the first one.*

The corpus format, the scoring and the metric definitions are
[`docs/eval-golden-set.md`](../../../docs/eval-golden-set.md). Nothing here
overrides it; this file answers the questions that document does not, because
they only arise on real documents.

## 0. The one prior rule

**Ambiguous cases are labelled conservatively and flagged, never silently
decided.** Conservative means: the label that penalises Cogeto for guessing.
If it is unclear whether a sentence carries a fact worth keeping, it is not a
`must_extract` label. If it is unclear whether two statements conflict, the pair
is `compatible`, not `contradicts`. Every case where that rule was applied says
so in its `notes.md` under a line beginning `AMBIGUOUS:`, so a disputed score can
be adjudicated against the reasoning instead of argued from memory.

## 1. What counts as a fact worth extracting from a specification

A specification is not a note. Almost every sentence in it is assertive, so
"the model said something true" is not a useful bar; if it were, a 40-page
regulation would yield 400 correct facts and none of them would be worth
remembering.

**Label a statement `must_extract: true` when it is a durable obligation,
limit, value, decision or definition that a competent person would later need
to look up.** Concretely, in this corpus:

- a normative requirement (MDR "manufacturers shall keep the technical
  documentation ... for a period of at least 10 years");
- a numeric limit, threshold, tolerance or rating with its unit and its subject
  (RP2040 "supports 1MHz to 15MHz crystals"; NN "ograda visine do 2,2 m");
- a dated transitional or effective provision ("until 31 December 2027, for all
  class III devices");
- a stated change to an earlier document ("Maximum crystal frequency increased
  from 15 MHz to 50 MHz"; "03.05.08 Withdrawn");
- the identity of the thing the document is about, where the document states it
  (the subject of a tender lot, the part a datasheet section describes).

**Do NOT label, and list under `must_not_extract`:**

- **Document machinery.** Publication numbers, notice identifiers, form types,
  OJ issue numbers, page footers, running heads, DOI banners, "This publication
  is available free of charge from ...". These are true and worthless.
- **Contact and registry rows.** Postal addresses, telephone numbers, email
  addresses, registration UUIDs, NUTS codes. A tender notice is mostly this.
- **Cross-references with no content of their own** ("in accordance with
  Article 114(3)", "Source Controls: IA-04"), unless the cross-reference IS the
  provision (an amending act that replaces a paragraph is content).
- **Discussion and rationale prose.** NIST's `DISCUSSION` blocks explain why a
  requirement exists; the requirement is the fact, the explanation is not.
- **Restatements of the same obligation inside the same excerpt.** One label per
  obligation; a second phrasing of it is a duplicate, not a second fact.
- **OCR debris.** Fragments a scan produced that are not words.

The bar in one sentence: **would a reader be worse off if this were missing from
an index of the document?** If not, it is not a label.

### The chosen consequence, stated rather than discovered later

This bar makes extraction **precision** on this corpus low, because the
extractor currently produces exactly the document machinery listed above and
every one of those is an unmatched fact. That is the intended measurement. The
alternative, labelling the machinery so it matches, would produce a flattering
number and a corpus that certifies behaviour nobody wants.

## 2. What counts as a genuine contradiction

Two statements contradict when **the same subject, in the same slot, under the
same conditions, is given incompatible values**, and both are asserted as
current.

All four qualifiers do real work here, and each one is the reason for a
negative case in this corpus:

1. **Same subject.** RP2040 supports 1 MHz to 15 MHz crystals; RP2350 supports
   1 MHz to 50 MHz. These are different parts. **Not a contradiction**, and a
   system that flags it would fill a findings report with noise. The two
   datasheets share their boilerplate almost word for word, so this is the
   central trap of the corpus.
2. **Same slot.** Lot 4c is two 400/110 kV transformers at 300 MVA; Lot 4d is
   two 110/22.5 kV transformers at 125 MVA. Same notice, same units, different
   things being rated. **Not a contradiction.**
3. **Same conditions.** A datasheet's `VIH` is 2 V at IOVDD=3.3 V and 1.7 V at
   IOVDD=2.5 V. A conditional qualification on either side means the statements
   do not meet. **Not a contradiction.** Where a condition appears on ONE side
   only, the pair is labelled `compatible` and flagged AMBIGUOUS, because an
   unconditioned statement may or may not have been intended to cover the
   conditioned case, and Cogeto must not decide that for the user.
4. **Both current.** NN 112/17 sets an underground container depth limit of 2 m;
   NN 74/22 amends the same point to 3,5 m. The second **supersedes** the first;
   it does not contradict it. Labelled `supersedes_a_over_b` with the amendment
   as `a`.

**Precision differences are not contradictions.** "at least 10 years" and
"10 years" for the same obligation are the same fact at different precision, and
a value stated to more decimals than another is the same value. Both are dedup
`same_fact`, not conflicts.

**Unit differences within one dimension are not contradictions by themselves.**
15 cm and 0,15 m are the same length. A pair only conflicts once converted
values disagree.

**A withdrawal is a conflict about a decision, not about a value.** NIST r2
requires prohibiting password reuse; r3 marks the same control Withdrawn. Same
subject, same slot, opposite decisions, and the later document is the successor
revision, so it is supersession.

## 3. When two documents about different models must not be paired

**A statement inherits the subject of the document or section it came from, and
that subject is part of the fact.** Two documents must not be paired when their
anchored subjects differ, even when their sentences are near-identical.

This corpus makes that explicit in three places:

- RP2040 and RP2350, whose XOSC sections share paragraphs verbatim;
- the same Abracon ABM8-272-T3 crystal table reproduced in both datasheets,
  where the subject is the CRYSTAL, not the microcontroller, so the two copies
  **are** the same fact and must merge (the mirror image of the trap above);
- the three lots of the Croatian mask tender (FFP3 without valve, FFP2, and a
  three-layer medical mask), which share their boilerplate and differ by product
  class and value.

Where a case exists to prove a subject was anchored correctly, the label
declares `subject_entity` explicitly, which puts it under the zero-tolerance
`subject_mismatches` gate.

## 4. Conditional and hedged statements in the source

Documents hedge constantly, and the hedges are load-bearing.

- **A condition in the source belongs on the label** (`condition`), verbatim in
  substance. "provided the conditions set out in paragraph 3c are met" is part
  of the fact, not decoration.
- **A hedge in the source is not a hedge by Cogeto.** "may be placed on the
  market" is the regulation's own modality. The label records the statement as
  the document makes it; `verification_expected` stays `supported` because the
  span does support the claim.
- **"at least", "up to", "do" (Croatian), "no later than"** are bounds, and the
  bound belongs in the label. A fact that drops the bound and asserts the bare
  number is wrong, not imprecise.
- **An assignment placeholder is not a value.** NIST r3's "[Assignment:
  organization-defined frequency]" means the document deliberately declines to
  state one. A label must not invent a frequency, and a fact that does is a
  fabrication, not a paraphrase.

## 5. Traceability

Every case directory carries a `notes.md` with:

- **Source**: the document id from `documents.json` and the exact page range or
  text anchor the excerpt came from.
- **Why this case exists**: what it is designed to catch.
- **The reasoning for each label**, including every `must_not_extract` decision
  that a reasonable person might have made differently.
- **`AMBIGUOUS:` lines** where rule 0 was applied.

Pair cases carry the same, plus which document each side came from, so a
disputed verdict can be checked against both originals rather than against the
pair file.

## 6. Excerpts are verbatim

Every `source.txt` is the output of Cogeto's own reader over the original
document, sliced on page boundaries (or, for the two Narodne novine regulations
published as HTML, the article text mechanically converted: tags stripped,
entities decoded, leading and trailing whitespace per line removed). **Nothing
inside an excerpt is edited, tidied, reflowed or paraphrased.** Two reasons:

1. The RP2040 and RP2350 datasheets are CC BY-ND, which permits reproduction in
   whole or in part but not adapted material. A tidied excerpt would be an
   adaptation.
2. Tidying is the flattery this corpus exists to avoid. The tabs a 1987 scan
   injects between words, the masculine ordinal indicator the RP2040 datasheet
   uses where RP2350 uses a degree sign, the page footer that lands in the
   middle of a table: those are the input, and a corpus that removes them
   measures a document nobody has.

A case that needs different text needs a different excerpt, never an edited one.

## 7. Changing a label

Same rule as the core corpus: one line in
[`CHANGELOG.md`](CHANGELOG.md), and, where the change moves a headline metric,
the justification goes in the pull request that makes it. Adding a deliberately
hard case is good work and it lowers metrics; that is a reason to say so, not a
reason to say nothing.

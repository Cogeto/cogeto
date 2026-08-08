# xl-vr05: the same provision points at two different articles

**Sides.** `a` from `mdr-2017-745-hr` page 90; `b` from `mdr-2017-745-en`
page 90. Article 120(12) of Regulation (EU) 2017/745.

**Expected.** `contradicts`.

**How it was found, because the method matters.** It was not read out of the
document by hand. The two language versions of the act are paginated
identically, so a short script extracted every number from each page of each
version and compared the two sets page by page. Four pages differed. Two were
typesetting noise; two were substantive, and both are now pairs in this corpus:
Article 10(7)'s registration cross-references (`xl-vr02`) and this one.

That is worth writing down because it is the answer to "how would anyone find
this". Nobody reads two 175-page legal texts side by side in two languages. A
machine can, and surfacing exactly this is what a findings report is for.

**Reasoning.** Under EU law both versions are equally authentic, so neither is
the correction of the other and neither supersedes the other. Same subject
(who counts as a designated issuing entity for unique device identifiers), same
slot (the provision that ends the interim arrangement), both current,
incompatible content: rule 2 of LABELLING.md is satisfied on all four
qualifiers, so the verdict is a contradiction for a human.

**What makes it hard.** The conflict is between two article citations, not two
quantities, so the deterministic quantity arm from V2.3 item 6.1 sees nothing.
Worse, the numbers involved (27, 2, 33, 7) will parse as bare integers with no
unit, which is the shape most likely to be discarded before the judge ever sees
it. And the sentences are ordered differently in the two languages, so the
conflicting tokens are not in comparable positions.

AMBIGUOUS: as with `xl-vr02`, it can be argued that this is a known translation
defect rather than a legal difference. The same answer applies: that judgement
belongs to the user, and the conservative behaviour for a compliance product is
to raise the discrepancy. Recorded so a future labeller can weigh it.

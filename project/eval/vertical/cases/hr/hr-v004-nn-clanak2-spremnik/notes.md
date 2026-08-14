# hr-v004: Pravilnik o jednostavnim građevinama, članak 2. (izvorni tekst)

**Source.** `nn-112-2017-jednostavne-gradevine`, article 2, from the official
Narodne novine text of the regulation as first published.

**Why this case exists.** Three reasons.

1. **It is Croatian-origin material, not a translation.** The MDR Croatian text
   is an authentic language version of an act drafted elsewhere; this
   regulation was written in Croatian by a Croatian ministry. The corpus needs
   both and says which is which.
2. **It is dense with Croatian numeric limits**: 27 m3, 20 m2, 12 m2, 2,2 m,
   1,6 m, 90 dana. The decimal comma is native here, and the area units are
   the ones `ingestion/domain/quantity.ts` does not know, which the diagnostic
   report records.
3. **It holds the earlier value of the corpus's Croatian revision pair.** The
   underground waste-container store is limited to a depth of 2 m here and to
   3,5 m in the 2022 amendment (`hr-v006`). Pair `hr-vr01` scores the
   supersession.

**Labels.** Twelve. `subject_entity` is declared on the two facts that the
revision pair and the negative pairs depend on.

**Not labelled.** List items that name a structure type with no limit attached
(vrtna sjenica, pješačka staza, boćalište) and the bare cross-reference to the
Zakon o gradnji.

AMBIGUOUS: the fuel-tank item is labelled as an exclusion from an exemption
rather than as a permission, because that is how the sentence is built. It is
the hardest sentence in the excerpt to read correctly and a system that inverts
it produces a dangerous fact, so it is labelled deliberately rather than
skipped.

**Verification.** `supported`.

## The subject declarations were REMOVED, and why

This case originally declared `subject_entity` on two labels ("Ograda" and
"Podzemni spremnik za smještaj tipskih kontejnera za komunalni otpad"), which
puts them under the zero-tolerance `subject_mismatches` gate. The first live run
of the corpus returned **null** for both: on a Croatian regulation's enumerated
list items the pipeline anchors no subject at all.

The declarations were removed rather than kept red. The governing rule inherited
from V2.0 item 3.4 is explicit: never set a gate the project is currently
failing, because a permanently red gate is not a gate, it teaches people to
bypass it. Keeping them would have made `main` red on a defect this unit does
not fix.

**Nothing is hidden by the removal.** The behaviour is published as finding 3 of
[`../../../../../../docs/eval/vertical-corpus-diagnostic.md`](../../../../../../docs/eval/vertical-corpus-diagnostic.md),
and the pair cases `hr-vr01` and `hr-vr05` still depend on the subject being
right, so a regression still shows up in the reconciliation rates. Turning the
declarations back on is the first thing to do in the change that ships
section-level subject anchoring, and it will need a fresh floor measured the
same way every other floor here was.

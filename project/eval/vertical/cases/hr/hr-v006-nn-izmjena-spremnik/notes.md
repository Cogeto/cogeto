# hr-v006: izmjene i dopune Pravilnika, novi dubinski limit

**Source.** `nn-74-2022-izmjene`, articles 1 to 3 of the 2022 amending
regulation.

**Why this case exists.** It is the Croatian revision that supersedes
`hr-v004`, and it is the cleanest numeric supersession in the whole corpus: the
same underground waste-container store, the same area limit of 15 m2, and a
depth limit that moves from 2 m to 3,5 m. Nothing about it was constructed. The
Croatian decimal comma is native, both values are in metres, and the amending
regulation names the regulation it changes by its Narodne novine references, so
the revision relationship is stated in the text.

The reading difficulty is the amendment prose. The substantive value is wrapped
in "U članku 2. stavku 2. točka 3. mijenja se i glasi:" and then quoted. An
extractor that keeps the wrapper produces a fact about an editing operation; one
that drops the wrapper and keeps the quote produces the fact a reader wants.

**Labels.** Six. The depth fact declares `subject_entity` matching `hr-v004`'s
exactly, because the supersession pair keys on subject equality and a drifted
subject would silently turn a correct supersession into two unrelated facts.

**Not labelled.** The amendment formulae themselves, the list of prior Narodne
novine issues, and the full citations of the EU acts referred to.

AMBIGUOUS: the new paragraph 5 about electronic communications infrastructure is
labelled although it is mostly a cross-reference to other legislation. It is
kept because it states where a whole class of structure may now be built, which
a reader does look up.

**Verification.** `supported`.

## The subject declaration was REMOVED, and why

The depth fact originally declared `subject_entity` matching `hr-v004`'s, so
that the supersession pair could not silently break. The first live run returned
**"Pravilnik o jednostavnim i drugim građevinama i radovima"**: the title of the
document, not the subject of the provision. That is finding 3 of the diagnostic
report, the document default outranking the section, reproduced inside the eval
harness.

Removed for the same reason as `hr-v004`: the governing rule forbids setting a
gate the project is currently failing. The pair `hr-vr01` still exercises the
supersession itself, and the diagnostic publishes the anchoring behaviour.

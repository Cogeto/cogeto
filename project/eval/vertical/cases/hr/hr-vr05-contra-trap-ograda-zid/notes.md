# hr-vr05: ograda i ogradni zid nisu isti predmet

**Sides.** Both from `nn-112-2017-jednostavne-gradevine` article 2, points 3 and
4 (case `hr-v004`).

**Expected.** `compatible`.

**Reasoning.** LABELLING.md rule 2, qualifier 1, in Croatian and with the
thinnest possible margin. "Ograda" (a fence) and "ogradni zid" (a fence wall)
are different structures with different height limits, and the second term
contains the first as a word. Any subject folding that strips a modifier, or any
alias rule that treats a longer name as a variant of the shorter one, merges
them and produces a conflict between 2,2 m and 1,6 m.

V2.3 item 6.1 added a mid-token typo rule and a growable alias set to make
cross-language and near-miss subjects pair. This pair is the counterweight: it
fails if that machinery is too eager, and the two together define the width of
the band.

**Not ambiguous:** the regulation lists them as separate points with separate
limits.

# hr-vr04: ista vrijednost, različiti pravni uvjet

**Sides.** `b` from `nn-112-2017-jednostavne-gradevine` article 1 paragraph 3
(case `hr-v005`); `a` from the same regulation, article 2 paragraph 1 (case
`hr-v004`).

**Expected.** `distinct`.

**Reasoning.** The hardest negative in the Croatian half, because everything a
similarity comparison can see is identical: the same object, the same 27 m3
limit, the same unit, the same document, the same day. The difference is one
clause. Article 2 grants a general exemption from the building permit; article 1
paragraph 3 grants an exemption that holds even against the spatial plan
("protivno prostornom planu"), which is a materially stronger permission.

A false merge here keeps one of the two and silently drops the other, and which
one survives decides whether an answer to "may I build a 20 m3 cistern here"
is right or wrong. Dedup traps count double in the harness for exactly this
reason.

AMBIGUOUS: a labeller could argue that both sentences state the same permission
at different scopes and that the merged fact would simply be the weaker one.
`distinct` is the conservative label under rule 0, because merging destroys the
distinction while keeping both costs only a duplicate.

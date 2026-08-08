# en-vr05: the same crystal in two datasheets must merge

**Sides.** `a` from `rp2350-datasheet` page 556 (Table 597); `b` from
`rp2040-datasheet` page 217 (Table 257).

**Expected.** `same_fact`.

**Reasoning.** LABELLING.md section 3 says a statement inherits the subject of
the section it came from, and here that subject is the Abracon ABM8-272-T3
crystal, not the microcontroller whose datasheet reproduces the table. Both
documents recommend the same crystal and copy the manufacturer's specification
table verbatim. Two sources, one fact.

Getting this right and `en-vr03` right at the same time is the point. They pull
in opposite directions across the same two documents, and a system that resolves
subject by document rather than by section fails exactly one of them.

**The codepoint trap.** RP2040 prints `-40 +85 ºC` with U+00BA, the masculine
ordinal indicator; RP2350 prints `-40 +85 °C` with U+00B0, the degree sign. Both
render as a small raised circle and no reader would notice. The excerpts keep
what each document actually contains (LABELLING.md section 6), so this pair also
measures whether unit handling survives real typography. The diagnostic report
records that `ingestion/domain/quantity.ts` recognises only U+00B0 today; that is
published, not fixed here, because this unit changes no application behaviour.

**Not ambiguous.**

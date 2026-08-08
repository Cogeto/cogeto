# hr-vr01: dubina podzemnog spremnika, izmjena iz 2022.

**Sides.** `a` from `nn-74-2022-izmjene` article 2 (case `hr-v006`); `b` from
`nn-112-2017-jednostavne-gradevine` article 2 paragraph 2 point 3 (case
`hr-v004`).

**Expected.** `supersedes_a_over_b`.

**Reasoning.** The cleanest numeric supersession in the corpus, and it was
found, not built. One provision, amended five years later: the plan area stays
at 15 m2 and the depth limit moves from 2 m to 3,5 m. The amending regulation
names the regulation it changes by its Narodne novine references, so the
revision relationship is stated in the text rather than inferred from dates.

Three things are being measured at once:

1. that the pair is a candidate at all, which needs the two subjects to fold
   together although the earlier text says "tipskih kontejnera" and the later
   one drops "tipskih";
2. that the deterministic quantity arm reads "3,5 m" with a Croatian decimal
   comma as 3.5 and not as 35;
3. that the direction is `a` over `b`, because the amendment wins.

**Not ambiguous.** The document says what it changes and to what.

**A known parser gap, recorded not fixed.** The area value 15 m2 is written
`15 m²` in both documents, and `ingestion/domain/quantity.ts` has no
square-metre unit, so the area half of each statement does not parse. It does
not affect this pair, whose conflict is in the depth, and it is in the
diagnostic report as a follow-up.

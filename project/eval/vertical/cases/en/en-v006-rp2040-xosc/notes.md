# en-v006: RP2040 crystal oscillator

**Source.** `rp2040-datasheet`, pages 217 and 218, section 2.16.

**Why this case exists.** Three things at once.

1. **A datasheet table flattened by a PDF text layer.** The Key Crystal
   Specifications table arrives as "Center Frequency 12.000 12.000 12.000 MHz",
   with the Minimum, Typical and Maximum columns run together and the header
   stated once, far from the row. Extraction from a table is a named task of the
   vertical set and this is what a real one looks like.
2. **Two subjects in one section.** Half the facts are about the RP2040 and
   half about the Abracon ABM8-272-T3 crystal. The crystal facts are the ones
   that must MERGE with their RP2350 twin (`en-vr05`), and the RP2040 facts are
   the ones that must NOT (`en-vr03`, `en-vr04`). Getting the subject wrong
   inverts both.
3. **The degree sign.** This datasheet writes the masculine ordinal indicator
   U+00BA where RP2350 writes the degree sign U+00B0. Both render as a small
   circle. The corpus keeps the difference because it is real input.

**Labels.** Thirteen. `subject_entity` is declared on the crystal-range fact,
which puts it under the zero-tolerance `subject_mismatches` gate: an anchored
subject of RP2350 or of "the crystal oscillator" on this fact would silently
disable the negative pairing this corpus depends on.

**Not labelled.** The register table fragment the page boundary pulled in, the
running footer, the bare figure caption, and the sourcing advice about resellers.

AMBIGUOUS: the equivalent series resistance and shunt capacitance are labelled
as one fact, and load capacitance with drive level as another, rather than four.
The rows are adjacent in one table about one part and a reader looks up the row
block. A labeller splitting them into four would raise recall's denominator
without changing what the system must do.

**Verification.** `supported`.

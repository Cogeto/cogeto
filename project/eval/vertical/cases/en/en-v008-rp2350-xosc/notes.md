# en-v008: RP2350 crystal oscillator, the same section for a different part

**Source.** `rp2350-datasheet`, pages 556 and 557, section 8.2.

**Why this case exists.** It is `en-v006` for a different chip, and several of
its paragraphs are word-for-word identical to the RP2040 ones. That makes it the
corpus's central boilerplate trap in both directions:

- the RP2350 facts must NOT merge or contradict the RP2040 facts, although the
  sentences around them are the same (`en-vr03`, `en-vr04`);
- the Abracon crystal facts, whose table is reproduced identically in both
  datasheets, MUST merge, because the subject is the crystal and both documents
  say the same thing about it (`en-vr05`).

It also carries the corpus's one explicit in-document revision statement:
"Maximum crystal frequency increased from 15 MHz to 50 MHz". That sentence is a
document telling you what changed, which is the shape authority ranking will
eventually have to reason about.

**Labels.** Thirteen, with `subject_entity` declared on the crystal-range fact,
mirroring `en-v006`.

**Not labelled.** Running footers, the figure caption's explanation of
piezoelectric resonance (physics background, not a specification), the sourcing
advice, and the pointer to the Pico 2 schematic.

AMBIGUOUS: the 5 MHz PLL minimum sits in a NOTE box, and NOTE boxes are
formatting rather than normative in many documents. It is labelled because it
states a hard lower bound a designer must respect, which is the section 1 bar.

**Verification.** `supported`.

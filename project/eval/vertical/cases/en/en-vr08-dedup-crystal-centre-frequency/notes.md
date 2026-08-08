# en-vr08: the same frequency at two precisions

**Sides.** Both from `rp2040-datasheet` page 217 (case `en-v006`), one from the
prose and one from Table 257.

**Expected.** `same_fact`.

**Reasoning.** The plan names "precision differences that are not
contradictions" as a case type that had no coverage. This is the real instance:
a datasheet states a crystal as 12MHz in a sentence and as 12.000 with three
Minimum, Typical and Maximum columns in the table two paragraphs later. Nothing
disagrees; the table is simply more precise.

Scoring it as a dedup pair rather than a contradiction pair is deliberate. The
question a user cares about is whether their memory ends up holding one fact or
two, and two copies of a crystal frequency at different precisions is the kind
of duplicate that makes a findings report look padded.

AMBIGUOUS: an argument exists that the prose fact is about the reference design
and the table fact is about the crystal part, which would make them distinct.
The label takes the merge position because both sentences are in one section
introduced by "it is recommended to use the Abracon ABM8-272-T3", so the
document itself treats them as one subject. A labeller who disagrees should flip
this to `distinct` and say so in the changelog; the reasoning is here to argue
with.

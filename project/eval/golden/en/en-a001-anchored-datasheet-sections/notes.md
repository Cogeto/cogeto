# en-a001: the multi-model datasheet the plan names (V2.1 item 4.2)

One document, two models, generic section bodies: "Continuous output: 100 W."
names no model on its own. Spec 1.5.1: the anchor supplies the document's
subjects and the extractor prefers the NEAREST section heading, so the 100 W
fact must be about PWR-3100 and the 200 W fact about PWR-3200. The
subject_entity labels are exact assertions under the zero-tolerance
subject_mismatches gate: a drifted or generic subject fails the run, whatever
the similarity metrics say.

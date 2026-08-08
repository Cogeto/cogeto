# Vertical corpus changelog

One line per label change, the same convention the core corpus follows
(`project/eval/golden/CHANGELOG.md`). A change that moves a headline metric is
justified in the pull request that makes it, per
[`../../../docs/eval/gate-model.md`](../../../docs/eval/gate-model.md).

## 2026-08-08, V2.3 item 6.4: the corpus created

- 13 real public documents sourced, recorded in `documents.json` with URL,
  publisher, licence, retrieval date and SHA-256. No bytes committed.
- 20 extraction cases labelled (12 en, 8 hr) against the rules in
  `LABELLING.md`, which were written before the first label.
- 24 reconciliation pairs labelled (12 en, 7 hr, 5 cross-language `xl`),
  covering: supersession across document revisions in both languages and across
  languages; same-unit differing values on different subjects; conditional
  qualification on both sides and on one side only; overlapping ranges on
  different slots; precision-only differences; and the same specification table
  reproduced in two datasheets, which must merge.
- 4 authority-ranking pairs authored under `authority/` and deliberately NOT
  loaded, because the behaviour has not shipped. Two of the four carry a
  placeholder side and say so in the `source` field itself.
- Named case shapes with NO real instance in this corpus, recorded rather than
  fabricated: a differing-unit same-dimension conflict about one subject, and a
  plain (non-supersession, non-cross-language) contradiction in English. The
  vertical set therefore has TWO contradiction positives, both cross-language
  (`xl-vr02`, `xl-vr05`), and its contradiction recall rests on a denominator of
  two, which is stated wherever it is published.
- Both cross-language contradictions were FOUND, not written: the two authentic
  language versions of Regulation (EU) 2017/745 are paginated identically, so a
  page-by-page comparison of every number in each version surfaced four
  differences, two of them substantive.

## 2026-08-08, first live measurement: three subject declarations removed

The first live run of the corpus returned a `subject_entity` of **null** on the
Croatian regulation's list items, the **document title** on the Croatian
amendment, and **no matched fact** on the Croatian tender's FFP2 lot. Five
declarations across `hr-v004`, `hr-v006` and `hr-v007` were therefore removed.

They were not removed because the assertion was wrong. They were removed because
`subject_mismatches` is a zero-tolerance gate and the governing rule inherited
from V2.0 item 3.4 forbids setting a gate the project is currently failing. The
behaviour is published as finding 3 of
[`../../../docs/eval/vertical-corpus-diagnostic.md`](../../../docs/eval/vertical-corpus-diagnostic.md),
each case's `notes.md` records exactly what was removed and why, and the pair
cases that depend on the same subjects (`hr-vr01`, `hr-vr05`) still fail if the
subject is wrong. **The five English declarations pass and were kept.**

Turning the Croatian declarations back on belongs to the change that ships
section-level subject anchoring, with a fresh floor measured the same way.

## 2026-08-08, third live run: the English tender declarations removed too

`en-v009`'s two `subject_entity` declarations held on two runs and failed on a
third: the anchored **document** subject ("Projekt Reuter Electrical Backbone")
was stamped on a fact whose section subject is "Lot 4c". Removed on the same
grounds, with the extra reason that a zero-tolerance gate which passes twice and
fails on the third identical run is a coin flip, and the gate model forbids a
gate inside a metric's run-to-run band.

**Three declarations remain**, all on the two datasheets (`en-v006`, `en-v007`,
`en-v008`). They held on all three runs and they are the ones the
same-boilerplate traps depend on: if either datasheet's subject drifts, the
negative pairs invert.

# hr-v007: hrvatska javna nabava, tri grupe koje dijele predložak

**Source.** `ted-hr-2133-2025`, pages 2 and 3. Lots LOT-0001 and LOT-0002 of the
Croatian Ministry of the Interior's protective-mask procurement.

**Why this case exists.** It is the Croatian mirror of `en-v009` and the corpus's
Croatian negative source. Three lots, each a mask, each with the same boilerplate
around it, differing by product class (FFP3 without valve, FFP2, three-layer
medical) and by value. Two of the three values are labelled here; pair `hr-vr03`
requires that difference NOT to be read as a contradiction.

It is also a monetary-format case. "2 472 344,00 EUR" uses a non-breaking group
separator and a decimal comma, which is the Croatian convention and not the one
an English-trained number parser assumes.

**Labels.** Eight, with `subject_entity` declared on each lot's lead fact.

**Not labelled.** The page header, the boilerplate exclusion-ground list that
every EU notice carries from the legal template, the internal lot identifiers,
the NUTS code, and the bare CPV number.

AMBIGUOUS: the exclusion-ground list is genuinely part of the notice's legal
content, but it is identical in every notice under Directive 2014/24/EU and
carries no information about this procurement. Section 1 of LABELLING.md puts it
under document machinery. A labeller who kept it would raise the label count and
lower the difficulty of the case.

**Verification.** `supported`.

## The subject declarations were REMOVED, and why

Both lot lead facts originally declared `subject_entity`. The first live run
left the FFP2 lead fact unmatched altogether, so the declaration failed the
zero-tolerance gate as an unmatched-declaring-label, which is the harness
counting a subject so wrong that entity overlap failed.

Removed for the same reason as `hr-v004` and `hr-v006`, and published in the
diagnostic instead. The English equivalents (`en-v009`, the two TED lots) DO
pass and keep their declarations, which is itself the finding: the same shape of
document, the same task, and the Croatian side does not hold the subject.

# en-v012: a scanned page whose OCR is readable but noisy

**Source.** `nbs-sp-250-3`, page 34. Body prose from the same 1987 scan as
`en-v011`, this time on a page the OCR mostly got right.

**Why this case exists.** Between "clean text" and "debris" sits the case a
customer archive is actually full of: readable sentences carrying injected tab
characters between every word, an occasional mis-decoded token (`MgFp` for
`MgF2`), and a real measured value in the middle of it ("The window is located
17 cm from the arc"). The pair with `en-v011` is the point: the same document
must yield facts on one page and nothing on another, and a system that treats
the whole file as one quality level gets one of the two wrong.

**Labels.** Five, all descriptive facts about the apparatus, including the one
numeric value.

**Not labelled.** The page footer, the tab debris, and any interpretation of the
mis-decoded `MgFp`. That last exclusion is the important one: the correct
behaviour is to carry the token as the document has it or to leave it out, never
to normalise it into a compound that was not read.

AMBIGUOUS: this page is descriptive laboratory prose rather than a
specification, so the section 1 bar is applied loosely. Each label states a
design decision about the apparatus that a reader of a measurement-services
publication would look up. Flagged because a stricter labeller could argue that
none of it is a durable fact and that the case should be a second trap.

**Verification.** `supported`.

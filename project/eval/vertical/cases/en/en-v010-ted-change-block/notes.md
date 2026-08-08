# en-v010: the document-machinery page

**Source.** `ted-178149-2026`, page 8, the final page of the notice.

**Why this case exists.** It is the precision case, and it is deliberately
hostile. Almost every line on this page is a true, well-formed, confidently
assertable statement, and almost none of it is worth remembering: an eSender's
postcode, two version UUIDs, a form type, a notice subtype, three dates about
the notice rather than about the procurement.

The first diagnostic ingestion of this corpus produced facts of exactly this
shape from exactly this page ("The notice subtype is 17", "The OJ S issue
number is 52/2026", "The registration number of the buyer is
3e025792-5ba4-4a12-b748-7f0a00ef8429"). They are the single largest contributor
to precision loss on real documents, and this case is where that is measured
rather than described.

**Labels.** One. The page states one thing a reader would look up: that this
notice supersedes an earlier version, and why. Everything else is machinery.

**Not labelled.** Listed exhaustively in `must_not_extract`, because on this
page the exclusions are the content of the case.

AMBIGUOUS: the notice dispatch and publication dates are excluded although a
procurement lawyer might want them. They are metadata about the document, not
about the contract, and section 1 puts document machinery outside the bar. A
labeller who disagrees should note that including them would raise this case's
precision without changing anything the system does.

**Verification.** `supported`: the single label is directly asserted by the
Change block.

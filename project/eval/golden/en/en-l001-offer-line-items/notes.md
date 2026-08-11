# en-l001 — offer line items (issue #499)

The failure this case pins, observed on a real 38-invoice corpus: a fully
text-read multi-page offer produced header furniture (address, phone, e-mail)
and the totals, and ZERO product line items, so "how much did we pay for X
and in what quantity" was unanswerable while the number sat on a readable
page.

The source mirrors the real reader output shape: European number formatting,
tab-separated numeric columns under a header row (Qty, Unit price, Disc.%,
Line total), catalog boilerplate glued to an item description (the UL note,
the ordering-code legend), a letterhead block, totals, validity and terms.

Labels: one fact per table line with article code, quantity, unit price and
line total (the v0006 rule); the totals row and the validity as their own
facts. The letterhead is asserted out as prose in must_not_extract and
measured through precision: a scored must_not_contain needle was tried first
and removed, because the needle also scans each fact's verbatim source_span,
and a legitimate span crossing the header line makes any letterhead
substring a false-positive zero-tolerance trap.

No subject_entity declarations: subjects on commercial documents are issue
#498's territory, and this case must not gate on them.

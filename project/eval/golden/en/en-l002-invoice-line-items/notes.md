# en-l002 — invoice line items and due date (issue #499)

The sibling of en-l001 in invoice form: space-aligned columns instead of
tabs, plain decimal points, a shipping row, a due date. The real corpus's
user question that motivated the whole unit was "how much did we pay for X
and in what quantity" followed by "when is it due" — this case carries both
answers as must-extract labels.

The retention-of-title clause is a must_extract:false label: a diligent
assistant may reasonably store it, and matching it should lift precision
without punishing an extractor that leaves legal boilerplate alone.

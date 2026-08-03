# en-x001: a clean tabular sheet

The base case for the spreadsheet reader (V2.1 item 4.1, issue B1). A sheet with
the header on row 1 and nothing decorative anywhere: whatever the reader gets
wrong here, it gets wrong everywhere.

What it is really testing is that a ROW carries its column context. The reader
emits `Supplier: Adriatic Foods; Country: Croatia; Payment terms (days): 30`
rather than `Adriatic Foods, Croatia, 30`, and the two labelled payment-term
facts are the ones a tuple could not have produced: with the column names gone,
`30` is a number in a row, not a payment term.

The country labels are `must_extract: false` on purpose. A diligent assistant
would not write down that a supplier is in Croatia as a standalone fact worth
remembering, but the extractor may reasonably produce it, and labelling it keeps
precision honest instead of punishing a defensible extraction.

`source.xlsx` is the real workbook; `source.txt` is what the reader made of it,
and `files/reading/golden-fixtures.spec.ts` fails if those two ever disagree.

## A note on the label granularity

One `must_extract` label per ROW, with the column splits beside it as
`must_extract: false`.

The first version of this case asserted one label per column pair, and the two
languages then scored differently on identical content: the English run split
each row into "has 30-day terms" and "contract ends 2027-03-31", the Croatian run
merged the same row into one fact. Both are correct readings of one ledger row,
and a label set that only matches the split version measures formatting rather
than memory. The row-level gist matches either shape; the split labels keep
precision honest when the model does split.

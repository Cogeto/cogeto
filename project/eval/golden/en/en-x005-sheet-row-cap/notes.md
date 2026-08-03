# en-x005: a sheet that truncates at the cap

The workbook holds 24 invoice rows and `read.json` caps the read at 4, so
`source.txt` is what the pipeline actually receives from a file too large to read
whole (V2.1 item 4.1, issue B2).

Two things are being asserted, in two places.

Here, that the four rows that WERE read extract as four ordinary facts: a cap is
not an error, and a truncated read must still produce good facts from what it
saw. Nothing in the text says anything about truncation, which is deliberate. A
sentence like "20 further rows were not read" would be extracted as a fact and
remembered as one, so the notice lives on the read report and in the source
drawer instead, where it is shown to a person and never to the extractor.

The other half is in `files/reading/spreadsheet.spec.ts` and on the read report:
`rowsRead: 4, rowsTotal: 24, truncated: true`, reason `row_cap_sheet`. That is
what makes the read honest. A user who uploads a fifty-thousand-row export and
is told nothing has been quietly handed part of a file and left believing it was
all of it.

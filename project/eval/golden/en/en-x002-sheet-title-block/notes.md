# en-x002: a title block above the header

The shape almost every real exported sheet has and almost no parser expects: a
merged report title across the top, a "prepared by" line, a blank row, and only
then the header (V2.1 item 4.1, issue B1).

Two failures are being ruled out at once.

If the reader takes row 1 as the header, every column is called "Delivery
commitments, Q3 2026" and every fact is nonsense. If it throws the title block
away instead, the facts survive but lose the quarter and the author, which is
exactly the context that makes them findable later. The reader does neither: the
title rows become the sheet's context line, and the header is found on row 4.

The two labels are commitments rather than facts because that is what the sheet
records: a named owner, a named deliverable, a date. Note that the row numbers
in the locators are 5 and 6, not 1 and 2, so a fact traces to where it actually
sits in the file a person will open.

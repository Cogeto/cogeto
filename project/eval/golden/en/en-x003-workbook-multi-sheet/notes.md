# en-x003: a multi-sheet workbook

Two sheets about the same vendors, each with its own header and its own meaning
(V2.1 item 4.1, issue B1). The read must keep them apart: a renewal date on the
Renewals sheet and a category on the Vendors sheet are facts about the same
company from two different tables, and the locator has to say which.

The reader gives each sheet its own context line naming it and its position
("sheet 2 of 2"), and every statement's locator carries the sheet name, so a
fact about a 90-day notice period traces to `Renewals!A3:C3` and not merely to
"the workbook".

Björn Nordström is here deliberately: the name survives the XLSX shared-string
table unharmed, which is the encoding half that hr-x004 tests for CSV.

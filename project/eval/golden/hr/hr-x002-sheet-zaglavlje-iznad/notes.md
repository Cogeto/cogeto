# hr-x002: naslovni blok iznad zaglavlja

The Croatian twin of en-x002, and the case that caught a real defect while it was
being written: the title row ends in a full stop in Croatian (`Q3 2026.`), and
the context line joined it with another one, producing `Q3 2026.. Pripremila`.
The joiner now respects punctuation the document already had.

## An unflattering result, recorded rather than tuned away

This case does not fully agree on verification, and the reason is worth keeping.

The extractor reads both rows correctly. The verifier then judges the second
claim (Marko Babić, pilot site live by 30 September) **unsupported**, reasoning
that "the surrounding text shows Ana Kovač prepared the sheet, not Marko Babić":
it took the title block's `Pripremila Ana Kovač` as the authority for every row
and overrode the row's own `Nositelj: Marko Babić`.

The English twin, same structure, verifies both claims supported. So this is
model behaviour on Croatian rather than a defect in the flattening, and the fix
is not to delete the title block, which is real context a reader needs and which
V2.1 item 4.2 formalises. It is left here, failing, because a corpus that only
holds cases the system passes measures nothing. Croatian verification agreement
stays above its floor with this case counted against it.

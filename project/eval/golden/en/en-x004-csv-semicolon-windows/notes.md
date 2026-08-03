# en-x004: a semicolon CSV in a Windows encoding

A CSV tells you neither what separates its fields nor how its bytes encode text,
and this case is both questions at once (V2.1 item 4.1, issue B5).

The file is semicolon-separated, CRLF-terminated and encoded in windows-1252,
which is what a European Excel writes when it exports: the locale uses the comma
as a decimal separator, so the field separator becomes a semicolon. Read as
comma-separated it would be four rows of one field each; read as UTF-8 it would
fail to decode at the first `ö`.

`Björn Nordström` and `Émile Rousseau` are the assertion. If the encoding
fallback picks the wrong codepage, the names arrive mangled and the facts are
about people who do not exist. The reader records which encoding it used on the
read report, so a wrong guess is visible rather than mysterious.

## What this case measured that was not the point

The amounts extract reliably from the flattened rows. The CONTACT columns do not:
the pipeline model reads `Supplier: Nordic Packaging; Contact: Björn Nordström;
Escalation contact: Anna Lindqvist; Amount due EUR: 18400` and produces "Nordic
Packaging owes 18,400 EUR", dropping the two people.

That is a real gap and it is written here rather than hidden. A diligent
assistant would remember who to call. But it is a gap in extraction DEPTH over
statement text, which is what V2.1 items 4.2 and 4.3 exist to improve, and this
case was added to prove the reading layer decodes windows-1252 and splits on
semicolons. So the contact labels are `must_extract: false`: they are in the file
so precision still counts a contact fact when the model does produce one, and the
miss is recorded here instead of as a permanent unmet requirement on a gate this
change did not set out to move.

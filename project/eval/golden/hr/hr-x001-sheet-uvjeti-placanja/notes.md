# hr-x001: čist tablični list

The Croatian twin of en-x001. It exists separately because the column labels are
the extraction context, and Croatian column labels inflect: `Rok plaćanja
(dana)` has to survive into the fact as a payment term, not as a bare number.

The diacritics are load-bearing here too. The file is a real XLSX, so its text
is UTF-8 inside the package; the Windows-encoded case that stresses decoding is
hr-x004.

## A note on the label granularity

Same as en-x001, and this case is where it showed: the Croatian run merged each
row into a single fact while the English run split it into two. One
`must_extract` label per row, column splits beside it as `must_extract: false`,
so both readings of one ledger row match.

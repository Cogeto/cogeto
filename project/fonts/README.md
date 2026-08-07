# Report fonts

The typefaces embedded in generated findings-report PDFs (V2.3 item 6.2):
DejaVu Sans and DejaVu Sans Bold, release 2.37, vendored verbatim from the
DejaVu fonts project. `LICENSE` alongside is the fonts' own license (the
Bitstream Vera license plus the DejaVu public-domain changes), which permits
redistribution and embedding.

Why vendored, and why DejaVu: a PDF that quotes evidence verbatim needs full
glyph coverage for every interface language, and Croatian's č, ć and đ sit
outside the encoding of the built-in PDF base fonts, so SOME Unicode face
must ship. DejaVu covers all four interface languages (and far beyond) under
a license that allows exactly this use, and vendoring keeps the offline
deployment story intact: nothing is fetched at build or run time.

The renderer embeds the files whole (no subsetting) as CIDFontType2 with a
ToUnicode map, so text copied out of a report reproduces the quoted evidence
exactly. Replace a face only with one of at least equal glyph coverage, and
keep this README and the license in step.

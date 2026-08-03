# vision_read

The prompt for tier three of the reading ladder (V2.1 item 4.1): a page that has
no usable text layer and that local OCR could not read either.

## v0001 (2026-08-03)

First version. Two labelled parts (`TEXT:` and `FIGURE:`) so a transcription and
a figure description are distinguishable downstream rather than run together.

The constraints are the whole prompt. Output from here is treated as the page's
text and is then verified against itself, so verification cannot catch an
invented word: the span it checks the claim against IS the invention. That is
the epistemic gap this prompt exists to narrow, hence the explicit bans on
completing patterns, filling in illegible labels, and contributing knowledge the
model has but the page does not, plus `[unreadable]` as a first-class answer and
an exact sentinel for a page with nothing on it.

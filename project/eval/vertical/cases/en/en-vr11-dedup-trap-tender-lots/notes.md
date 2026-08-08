# en-vr11: two lots described in the same sentence must not merge

**Sides.** Both from `ted-178149-2026` page 3 (case `en-v009`).

**Expected.** `distinct`.

**Reasoning.** The datasheet trap (`en-vr09`) comes from a vendor reusing a
paragraph across two documents. This one comes from a procurement officer
reusing a sentence inside one document, which is more common and gives the
reconciler even less to work with: same document, same day, same author, same
words apart from the lot identifier and the transformer type.

Both facts also had the SAME capture time, so nothing about recency or
provenance separates them.

**Not ambiguous.**

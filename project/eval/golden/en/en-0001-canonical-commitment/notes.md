# en-0001 — the canonical conditional commitment

The smallest note that exercises the whole S2-A pipeline honestly:

- **One commitment**, first person implied ("send…" = the user will send).
- **A condition** ("after he confirms the budget") that must survive extraction as a
  separate `condition` field — folding it silently into the claim, or dropping it,
  is the classic specificity failure (research: memory-architecture §2).
- **An entity** (Luka) that must be preserved exactly, never translated.
- **No resolvable date** — `temporal.valid_from`/`valid_until` stay null and
  `anchors_resolved` is true (there is no unresolved anchor; there is simply no date).

Expected end state after ingestion: exactly one memory, `kind` commitment, status
`active` (verifier verdict `supported` — the claim restates the sentence).

Owner hand-check: capture this text on the Memories page; one active memory should
appear with the condition intact and a source link back to the note.

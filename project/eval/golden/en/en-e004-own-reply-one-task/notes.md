Thread isolation case: the user's OWN reply (self-routed,
`email_authored_by_owner: true`) whose new content carries one commitment,
with quoted history carrying someone else's. Thread-aware isolation strips the
quote, so extraction must produce the commitment from the user's own new text
and NOT the one buried in the quote. Fails the gate if quote-stripping
regresses (the quoted commitment would be extracted too).

Originally a P6.5 derivation trap (decision 0054, `expected_tasks: 1`). The
task subsystem was removed in 2.0 (decision 0060), so the task assertion is
gone; the extraction labels this case was always built on are unchanged and
the case id is kept so published scores stay comparable.

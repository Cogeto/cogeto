Derivation trap (P6.5, decision 0054): the user's OWN reply (self-routed,
`email_authored_by_owner: true`) whose new content carries one commitment,
with quoted history carrying someone else's. Thread-aware isolation strips the
quote, and the first-person rule derives from the user's own new text —
`expected_tasks: 1`, exactly one. Fails the gate if quote-stripping regresses
(two commitments would derive) or if user-authored email stops deriving
(zero would).

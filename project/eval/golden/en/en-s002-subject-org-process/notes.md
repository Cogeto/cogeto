# en-s002 — subject trap: org-process fact is ABOUT the org, not null

A fact about an entity's process or asset ("X's invoices go to ...") is ABOUT
that entity. The observed failure (issue #313) was a null subject on exactly
this shape, which disables the supersession/contradiction candidate gate for
the invoice-address chain (canon en-r008 expects "Adriatic Foods" on both
sides). The meeting frame ("after the finance sync") must not become the
subject either.

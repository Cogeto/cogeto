# en-s001 — subject trap: reporting frame vs project subject

The note leads with a meeting frame ("Team planning session — ..."). The fact is
ABOUT the Atlas CRM Migration (a project), not about the session: a session is
provenance, never a subject. This is the exact shape that broke the demo
sandbox's go-live contradiction pair (issue #313): the reconciliation candidate
gate requires equal non-null subjects on both sides, so a fact whose subject
drifts to the meeting (or to null) can never be flagged against its
contradicting twin, while every similarity metric still passes.

Declared `subject_entity` makes this a zero-tolerance trap: a mismatch on any
declaring case fails the `subject_mismatches` gate.

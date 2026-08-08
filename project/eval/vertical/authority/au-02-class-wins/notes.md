# au-02: a regulation outranks a tender notice

**PENDING. Not loaded by the harness. PARTLY SYNTHETIC.**

**Sources.** Side `b` is verbatim from `mdr-2017-745-en` page 23. **Side `a` is a
placeholder.** No document in this corpus states a retention period that
conflicts with the MDR's, so the conflict this case needs does not exist in the
material that was sourced.

**Why it is written anyway.** The plan names authority ranking by document class
as a case type. Writing the case makes the requirement concrete and makes the
gap visible: to gate it, someone must source a real procurement document whose
retention clause conflicts with a binding regulation, and record it in
`documents.json` on the same terms as everything else.

**Why it must not quietly move into `../cases/`.** The whole premise of this
corpus is that model-written fixtures flatter the system. A half-invented pair
sitting in a gated set would be exactly the false claim item 6.4 exists to
prevent. The placeholder text says so in the `source` field itself, so the case
cannot be moved by accident without someone reading it.

**Signal under test.** Document class. The expected verdict is
`supersedes_b_over_a`: the older, more authoritative document wins over the
newer, less authoritative one.

# au-04: a document that says your memory is stale without saying what is true

**PENDING. Not loaded by the harness. Fully real.**

**Sources.** Both sides from `ted-hr-2133-2025` page 11 and pages 2 to 3.

**Signal under test.** Revision, indirectly. The change block states that the
technical specifications, the bills of quantities, the draft contracts and the
submission deadline have all changed. It does not state the new values; those
are in procurement documents that live behind the contracting authority's
portal.

**Why it is the most interesting case in this directory.** Everything else here
is about picking a winner between two known values. This is about a document
invalidating facts whose replacements are not present. Nothing in Cogeto today
reasons from "this class of statement is superseded" to "these seventeen stored
facts are now uncertain", and no supersession mechanism keyed on comparing two
facts ever could, because there is only one fact.

**The behaviour it argues for.** A revision statement should be able to mark a
SET of facts stale by provenance (this source, this section) rather than by
pairwise comparison, and the honest outcome is `uncertain` with a named reason,
not deletion and not silence. That is a design note for a later version, not a
gate.

**Expected verdict, if it were run.** `contradicts`: hand it to a person. A
change notice that names what changed without saying to what is precisely the
case where a machine should stop and ask.

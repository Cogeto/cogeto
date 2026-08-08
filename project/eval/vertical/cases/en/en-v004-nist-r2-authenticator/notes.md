# en-v004: NIST SP 800-171 Revision 2, identification and authentication

**Source.** `nist-sp-800-171r2`, page 38 (document page 25). Requirements 3.5.4
to 3.5.10 with their DISCUSSION blocks.

**Why this case exists.** The earlier half of the standards revision pair, and
the corpus's clearest test of the DISCUSSION rule: a numbered requirement is a
fact, and the paragraph that explains it is not. Seven requirements sit beside
roughly the same volume of explanatory prose, so an extractor that cannot tell
them apart doubles its output and halves its precision.

**Labels.** Eight. Seven numbered requirements plus one sentence from a
DISCUSSION block that is itself a rule ("Password lifetime restrictions do not
apply to temporary passwords"), which a reader would look up.

AMBIGUOUS: that eighth label is the exception to the DISCUSSION rule and it is
flagged as such. It qualifies because it states a scope limit on an obligation,
not a rationale for one. A labeller who read it as discussion and dropped it
would be defensible; keeping it is the conservative choice, because dropping it
would let a system that misses a real scope limit score full recall.

**Not labelled.** Running heads, the DOI banner, the twice-repeated
"[SP 800-63-3] provides guidance on digital identities" pointer, and the
explanatory DISCUSSION prose.

**Verification.** `supported`.

# hr-0008 — zamka: spomenuti iznos nije dogovoreni iznos

The Croatian sibling of en-0002, harder in one way: the source *explicitly*
says "ništa nije dogovoreno", so extracting a decision about 30.000 EUR is not
just overreach — it contradicts the text. `verification_expected: unsupported`
refers to that trap candidate: if the extractor produces it anyway, the
verifier must not admit it as supported (harness v0 trap rule).

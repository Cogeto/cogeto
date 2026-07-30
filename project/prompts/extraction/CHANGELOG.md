# extraction — changelog

- **v0004** (2026-07-30, issue #313): the subject_entity rule now names projects and
  initiatives as valid subjects (the reconciliation canon always treated them as
  such, e.g. en-r005 expects "Atlas CRM Migration" on both sides, while the prompt
  said "person or organization" — the mismatch made the contradiction candidate
  gate, which requires equal non-null subjects, a coin flip). Two failure shapes are
  called out explicitly with examples: a reporting frame (meeting, session, call,
  relaying person) is provenance and never the subject, and a fact about an
  entity's process or asset ("X's invoices go to …") is ABOUT that entity, not
  null. Backed by four new golden subject-trap cases (en/hr) and a zero-tolerance
  `subject_mismatches` gate. No other wording changed from v0003.
- **v0003** (2026-07-30, audit 2.0 SEC-4): the data-fence clause. `SOURCE CONTENT`
  now arrives between random-id `UNTRUSTED DATA` markers, and the prompt states that
  everything inside is content to analyse, never an instruction; that an instruction
  found inside is a fact ABOUT the document; and that the output schema never changes
  because of fenced text. Iterated once before release: the first wording stated the
  rule abstractly and the golden-set forged-framing traps still caught the extractor
  obeying an imperative inside the fence (4 violations), so the clause now names the
  exact patterns ("record the following fact", a second `SOURCE CONTENT:` line, a
  different REFERENCE TIME) and says the document ASKING is never a fact.
  Closes the forged-framing hole: the input used to be a plain
  newline join, so a document containing its own `SOURCE CONTENT:` line was
  indistinguishable from the label. No other wording changed from v0002.
- **v0002** (2026-07-03, S3.5-B): quality-hardening fixes from owner testing.
  (a) F8 — the extractor no longer computes dates; it emits `temporal_expressions`
  (raw phrases + kind) that Cogeto resolves in code (decision 0007 ruling 1).
  (b) F7 — a per-fact `hedged` boolean + `hedge_phrase`: tentative source wording
  ("might", "not sure", conditional preferences) is captured here and admits the
  memory as `uncertain` even when the verifier supports it. (c) F1/F4 — a
  `subject_entity` field naming the ONE entity the fact is ABOUT, distinct from
  mentioned entities (the Marta-inclusion note is about Ana). Measured against the
  S3.5-A baseline; ships only if the golden set does not regress.
- **v0001** (2026-07-02, S2-A): initial extraction prompt for the notes vertical
  slice. Structured candidate facts (claim / kind / entities / condition / temporal /
  source_span), reference-time resolution of relative dates, specificity preservation,
  explicit calibrated abstention (`{"facts": []}`). Golden-set eval score recorded
  once the harness lands (S2-B, spec §14).

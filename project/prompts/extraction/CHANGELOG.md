# extraction — changelog

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
  once the harness lands (S2-B, §B.4).

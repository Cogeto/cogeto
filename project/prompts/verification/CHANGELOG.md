# verification — changelog

- **v0002** (2026-07-03, S3.5-B): F7 calibration. The verifier now judges
  **support only** and must not downgrade for tentative wording — hedging is the
  extractor's dimension (`hedged`), not the verifier's. Two embedded contrast
  examples: a plainly stated source-supported summary is `supported` (the Petra
  pattern, guarding false-positive downgrades), and a faithfully carried hedge is
  `supported`. Adds "a correctly resolved relative date is not an addition". Keeps
  v0001's independence rules (no shared wording with extraction) and downward tie-break.
- **v0001** (2026-07-02, S2-A): initial verification prompt (§B.3). Independent
  auditor phrasing — deliberately shares no wording or rubric with the extraction
  family. One claim + cited passage + surrounding context per call; verdict
  supported | partial | unsupported with a one-sentence reason; ties break downward.
  Verification-agreement eval score recorded once the harness lands (S2-B, §B.4).

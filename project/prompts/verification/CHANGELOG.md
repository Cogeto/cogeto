# verification — changelog

- **v0004** (2026-07-05, F2-B): the iteration v0003's measured run demanded
  (owner-sanctioned "v0004 if needed"). Debug verdicts on the failing hr cases
  exposed one true verifier bug — "listopadu" judged as November (hr-0006) —
  fixed with an explicit Croatian month-name table (listopad=October and the
  other false friends) plus contrast Example F pinning it. Also adds the
  conversation-attribution rule for relayed hearsay ("čuo sam se s Markom …
  navodno" → attributing the relay to Marko with the hedge intact is the plain
  reading — the hr-0012 pattern). The remaining hr disagreements were the
  verifier CORRECTLY demoting bad extractions (wrong direction hr-0001,
  hallucinated meeting hr-0004, unhedged forecast en-0024) — an extractor
  dimension the agreement metric conflates; documented in the F2-B session log
  and reflected in the honest gate floor rather than a lenient prompt.

- **v0003** (2026-07-05, F2-B): Croatian calibration. Keeps every v0002 rule and
  example; adds a "read Croatian as a native reader would" section with three
  contrast pairs mirroring the observed hr misses on the expanded corpus
  (docs/eval/history.md, 36-case run): present-for-future scheduling with an
  elided subject ("Krećemo 1. rujna" — the hr-0004 pattern), colloquial
  agreement wording plus faithful idiom paraphrase ("idemo na…", "nismo
  dirali" — the hr-0006 pattern), and the `navodno` hedging particle carried
  intact (the historical 57.1% suspicion), with the strengthened-counterpart
  warning inline. Also extends the resolved-relative-date rule to any language
  ("do petka"). Baseline before/after in the F2-B session log.
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

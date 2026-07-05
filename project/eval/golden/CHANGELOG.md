# golden set — changelog

One line per label change (docs/eval-golden-set.md §4 rule 5).

- 2026-07-03 (S2-A): seeded `en-0001` (canonical conditional commitment) and
  `en-0002` (designed overreach: discussed amount must not become a decision).
- 2026-07-03 (S2-B): golden set v0 — added `en-0003`–`en-0008` and
  `hr-0001`–`hr-0008` (16 cases total: 2 conditional-commitment pairs, relative
  dates, multi-fact notes, two nothing-to-remember cases, two designed traps;
  Croatian cases authored idiomatically, not translated). Thresholds live in
  `project/eval/eval-config.json` (v1).
- 2026-07-03 (S3.5-A): added the Ana corpus and calibration/date cases from
  owner testing — `en-0009`–`en-0016` (Ana Kovač at Adriatic Foods / Atlas CRM
  Migration: contact + risk register, two-wave decision, HubSpot cleanup open
  loop, archive-old-leads decision, Marta-inclusion with Ana as subject and
  Marta secondary [F1], GDPR risk, the HEDGED Teams preference expected
  `partial`/uncertain [F7], and the Petra SOW calibration case expected
  `supported`/active guarding F7 false-positives) and `en-0017`–`en-0019` (F8
  relative-date cases, each pinning `source_date` 2026-07-03 so the anchor is
  fixed forever; deterministic resolution verified in `temporal-resolver.spec.ts`).
  Adds the optional `source_date` field to the case format (per-case anchor).
- 2026-07-03 (S3.5-B): relabeled `en-0015` (hedged Teams) verification_expected
  `partial` → `supported`. v0002 splits the two dimensions: verification judges
  support only (the claim faithfully carries the hedge → supported), while the
  extractor's `hedged` flag drives the memory to `uncertain`. The old `partial`
  label encoded the F7 conflation the fix removes.
- 2026-07-05 (F2-B): corpus growth toward the §B.4 ladder — en `en-0020`–`en-0024`
  (two multi-fact notes, two temporal valid_until cases feeding the staleness
  pass, one designed forecast-overreach trap expected `unsupported`) and hr
  `hr-0009`–`hr-0012` (multi-fact, formal register that must NOT read as
  tentativeness [hr-0010], valid_until, and the `navodno` hedging-particle case
  [hr-0012] — the v0003 calibration targets), plus pairs `en-r009` (dedup trap:
  venue vs catering), `en-r010` (compatible trap: same board, different
  departments), `hr-r007` (dedup trap: nacrt vs konačni ugovor), `hr-r008`
  (compatible trap: zadovoljan cijenom + traži popust). Totals: en 30 items
  (24 extraction + 6 pairs), hr 17 items (12 extraction + 5 pairs). All
  fictional; hr authored idiomatically.
- 2026-07-05 (F2-A): added the reconciliation pair-case format (`pair.json` in a
  case dir; loader dispatches on file presence — decision 0010 ruling 9) and 14
  pairs: dedup `en-r001`–`en-r004` + `hr-r001`–`hr-r003` (7, of which 3
  false-merge traps: SOW-vs-report, GDPR-vs-vendor register, ponuda-vs-ugovor)
  and contradiction `en-r005`–`en-r008` + `hr-r004`–`hr-r006` (7: 4 contradicts,
  2 compatible traps, 1 supersedes with explicit update wording). Croatian cases
  authored idiomatically, not translated. Scored by `npm run eval` alongside
  extraction (dedup accuracy weights traps ×2 per spec §5).

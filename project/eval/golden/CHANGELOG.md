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
- 2026-07-05 (F3-B): task-judgment pair format (`task-pair.json`; extraction
  loader skips those dirs) and 10 pairs — closure en-t001–003 / hr-t001–003
  (fulfilled, progress-not-fulfillment, and the weight-2 false-close trap:
  same people, different obligation) and condition en-t004–005 / hr-t004–005
  (exact prerequisite vs scheduled-not-given). Chat suite gains
  `whats_still_open` (the day-one sentence verbatim), `open_with_entity`, and
  `closure_flow` (live capture→close→gone), with a `must_exclude` check.
  Totals: en 37, hr 24 items.
- 2026-07-05 (F3-A): temporal interval cases feeding time-travel retrieval —
  en `en-0025` (explicit from/until interval) + `en-0026` (open-start "until"
  bound), hr `hr-0013` + `hr-0014` (idiomatic twins, hr month names). Chat
  suite gains `previously_decided`, `point_in_time_march`, `changed_since`,
  and the `default_no_time_travel` regression case; the chat case format
  gains direct-fact seeding (`facts` with `supersedes` chains and fixed
  interval dates — deterministic reconciliation-independent seeds). Totals:
  en 32, hr 19 items.
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
- 2026-07-09 (O2-C): chat-capture corpus tick — 8 chat-sourced cases (4 en, 4
  hr), `source_type: "chat"`. Extraction: a stated decision (`en-0027`,
  `hr-0015`), a stated commitment that derives a task (`en-0028`, `hr-0016`), and
  a stated temporal fact with `valid_until` (`en-0029`, `hr-0017`). Task closure:
  a chat-stated fulfillment closes a task like a note (`en-t006`, `hr-t006`,
  family `closure`, expected `closes`). Croatian authored idiomatically, not
  translated. Corpus now 44 en / 30 hr subdirs. Scored by `npm run eval`
  (extraction + task-pair) with no gate regression.
- 2026-07-14 (O4 email source): email corpus tick — 8 email-sourced cases (4 en,
  4 hr), `source_type: "email"`. Extraction (run through the SAME thread-aware
  pre-processing the email SourceReader applies — `isolateEmailContent`): a
  threaded reply where only the latest message extracts (`en-e001`, `hr-e001`;
  quoted history stripped), a forwarded message where the innermost content
  extracts (`en-e002`, `hr-e002`; cover note + forward header stanza stripped),
  and an email commitment that must derive a task (`en-e003`, `hr-e003`).
  Contradiction: a two-email contradiction over a launch/decision date that feeds
  the dreaming path (`en-re01`, `hr-re01`, expected `contradicts`). New email
  extraction cases use empty `entities` (semantic-similarity match only) to avoid
  Croatian-declension false misses on the first email batch; tighten in a later
  tick as the corpus grows. Croatian authored idiomatically, not translated.
  Scored by `npm run eval` (extraction + reconcile) with no gate regression.
- 2026-07-14 (O4 email reply triggers): chat-eval tick — 2 draft-a-reply cases
  (`project/eval/chat/reply_to_ana` en, `reply_hr_zadnja` hr). Each seeds an
  `email_message` and runs a reply request ("draft a reply to Ana's last email";
  hr "napiši odgovor na zadnju e-poruku") through the real chat path with the
  chat→reply resolver wired; the deterministic confirmation must point to
  Approvals and state Cogeto never sends. The eval-chat harness gained an
  `emails` seed field + resolver wiring for these. The hr case uses "the last
  message" (target null → most recent) to avoid a Croatian-declension miss on a
  named target; tighten with fuzzier name matching in a later tick.

# reconcile_dedup — changelog

- **v0001** (2026-07-05, F2-A): initial dedup confirmation prompt (decision 0010).
  Verdict same_fact | distinct | related with a one-sentence reason; explicit cost
  table ("a false merge destroys a distinct fact; a missed merge merely duplicates")
  and the binding tie-break "same_fact loses every tie". Optional `merged_content`
  for enrichment, biased hard to null (returned only when exactly one record carries
  a concrete fact-bearing detail the other lacks). Three embedded contrast examples:
  plain duplicate (null enrichment), same-entities/different-slot-value trap
  (distinct), and a genuine enrichment case. Baseline scored by the reconciliation
  pair cases in the same session (docs/eval/history.md).

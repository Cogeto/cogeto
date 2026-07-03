# en-0017-date-by-monday

F8 date case. Anchor 2026-07-03 (Friday). "by Monday" must resolve to 2026-07-06 as valid_until (it wrongly resolved to 07-07 in owner testing). Deterministic resolution is verified exactly in temporal-resolver.spec.ts; this corpus case documents the expected end-to-end result once extraction v0002 emits raw expressions.

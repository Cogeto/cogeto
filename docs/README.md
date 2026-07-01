# docs — authoritative product documentation

The spec is the source of truth; when code and spec disagree, the spec wins (or is
updated deliberately). Precedence: **the Addendum wins over the scope doc and the
Specification wherever they conflict** (it is newer and resolves their open points).

- `Cogeto-v1-Addendum-Verifiable-Memory.md` — **binding** architecture decisions
  (Part A) + the Verifiable Memory feature set with sequencing tags (Part B).
- `Cogeto-v1-scope.md` — the locked v1 scope and strategy.
- `Cogeto-v1-Specification.docx` — the full v1 product specification.
- `Cogeto-Technical-Architecture.md` — full engineering plan: stack rationale,
  containers, mechanisms, phased implementation (the `.docx` is the presentation copy).
- `glossary.md` — the ubiquitous language; names in code must match it.
- `eval-golden-set.md` — corpus format, metrics, and CI gates for the eval harness.
- `research/` — anonymized engineering patterns distilled from studied production
  systems; required reading before implementing memory/agents/retrieval/pipeline code.
- `decisions/` — short numbered decision records; 0001 (repo structure) and
  0002 (technology stack) are binding.

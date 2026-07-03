# answer — the chat answerer prompt family

Grounded synthesis for the fast-path chat (§A.5): answers ONLY from the retrieved
fact blocks, cites every claim, says plainly when the facts do not cover the
question. Versioned like every prompt (§B.7); the active version is `answer/v0001`.

## Citation grammar (decision 0007 ruling 2 — one grammar, strictly enforced)

There is exactly **one** citation form the system trusts, stores, and renders:

```
{{cite:<memory-uuid>}}
```

- **Model-facing markers.** The prompt asks the model for short `[F1]`, `[F2]`
  markers keyed to the numbered `FACTS ON RECORD` blocks — models echo a two-token
  label reliably; they do not echo 36-char UUIDs reliably.
- **Backend canonicalization.** After generation, the post-processor
  (`toStoredAnswer`) maps each `[F#]` (including comma clusters like `[F2, F4]`)
  to `{{cite:<uuid>}}` using the supplied marker→memory map, then **strips every
  other bracketed or braced token** and counts each strip as a `citation_violation`
  (metadata only; never the content). The stored message contains only canonical
  cites to memories that were actually retrieved.
- **Renderer.** The SPA trusts only `{{cite:<uuid>}}`. Anything else — a raw
  `[F2, F4]`, a malformed brace, a cite to an id that was not supplied — is
  stripped before display. A raw marker can never reach the user (`citation_never_leaks`).

The grammar and the strip/canonicalize logic live in `@cogeto/shared`
(`citations.ts`) so the backend post-processor, the SPA renderer, and the tests
share one implementation.

> **v0001 note:** v0001 still instructs the model in `[F#]` markers; the strict
> grammar above is enforced by the renderer/post-processor regardless. A future
> `v0002` (S3.5-B) tightens the model-facing instructions (one marker per claim,
> never a cluster) to reduce violations at the source.

# 0026 — The token-revocation window bound, and the receipt chain-tip anchor (FIX-3: QS-11, QS-23)

**Status:** Accepted. **Context:** the quality/security audit
(`docs/audits/quality-security-audit.md`) raised two points that are policy
choices, not mere code fixes, so each gets a ruling here (the rest of FIX-3 is
recorded as one-line rationales in the session log).

## Ruling 1 — the Principal cache TTL bounds token revocation to a stated, accepted window (QS-11)

1. **The mechanism.** The identity seam caches a validated bearer token's
   Principal so it does not call Zitadel's userinfo endpoint on every request.
   A cache entry outlives a revocation: a token revoked at the IdP keeps working
   until its cache entry expires. This is inherent to any validation cache and
   is not a bug — it is a latency/security trade to be **bounded and stated**.
2. **The bound.** `cacheTtlSeconds` is lowered to **10 seconds** (from the prior
   larger value) on both the app and worker registrations. The residual
   revocation window is therefore **at most ~10 seconds**: after that a revoked
   or expired token is re-validated against the IdP and rejected. Ten seconds is
   short enough that a revoked session cannot meaningfully act, and long enough
   to keep userinfo traffic negligible under normal request rates.
3. **Accepted, not eliminated.** We deliberately do NOT drop the cache to zero
   (a userinfo round-trip per request) nor add IdP push-revocation for v1: the
   single-tenant deployment boundary (decision 0019) and the 10-second bound
   make the residual window an accepted operational property. It is documented
   in the identity seam README so an operator can see the exact guarantee.
4. **Local pre-validation (QS-17).** Independently, before trusting the cached
   userinfo, the seam now decodes the JWT locally and checks `iss` against the
   configured issuer and `aud` against the SPA client id — a malformed or
   wrong-audience token is rejected without any network call. Opaque tokens (the
   demo PAT) skip the decode and rely on userinfo as before.

## Ruling 2 — every exported receipt carries the chain tip as an external anchor (QS-23)

1. **The gap.** A deletion receipt (§B.1) is individually signed and hash-linked
   into the ledger chain, but an *exported* single receipt carried no reference
   to the rest of the chain. An instance operator who quietly dropped a
   *different* confirmed receipt from the ledger would not be detectable from any
   one exported artifact — the chain is only checked in aggregate at
   `GET /api/receipts/verify`, against the live ledger.
2. **The anchor.** `ReceiptDetailDto` (the exported artifact) now includes a
   `chainTip` = `{ hash, confirmedCount }`: the hash of the newest confirmed
   receipt (the head whose hash no other receipt references as `prev_hash`) and
   the count of confirmed receipts, both at export time. This is the cheap
   external anchor: whoever holds an exported receipt can later re-run verify and
   assert the tip they recorded still appears in the chain and the confirmed
   count has not gone *down*. Removing any confirmed receipt moves the tip and/or
   lowers the count, so the tamper is detectable from an independently-held copy.
3. **Why the tip, not the whole chain.** Embedding the full chain in every
   receipt is redundant and grows unboundedly; the tip hash + count is O(1),
   sufficient to detect deletion or truncation, and composes with the existing
   signature (which already protects each receipt's own contents). The tip is a
   monotonic anchor, not a proof of completeness — that remains the sweep's job
   (§A.7 step 4) — but it turns a silent drop into a checkable discrepancy.

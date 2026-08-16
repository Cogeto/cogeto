# Next work, recorded 2026-08-16

Context in two sentences: the 2026-08-15/16 maintenance push cleared the whole
dependency backlog (record: `dependabot-triage.md` beside this file), replaced
archived MinIO with the audited Silo fork under Cogeto custody, took Zitadel to
v2.71.19 (the last v2, with its security backports), and stabilised the eval
gates (`docs/eval/gate-model.md`, the four 2026-08-16 addenda). Master is green
including the live model gates; what follows is the deliberate work that
remains, in priority order.

## 1. Zitadel staged migration: v2.71.19 to v3, then v4

The identity provider is on the final v2 release. v2 is EOL; v3 and v4 are the
supported lines. Majors are not skippable: v2.71.19 to latest v3, verify, then
v4. Constraints that bind the work: REHEARSE each stage on a throwaway stack
before touching the dev instance (fresh Postgres restored from a dump of the
real `zitadel` database); take a fresh `pg_dump` backup before each real stage;
the setup migrations are forward-only, so the backup is the only rollback;
verify after each stage that OIDC discovery serves through the edge, login
works, the app and worker restart healthy, and roles resolve. Owner sign-off
between stages. License note, already reviewed and accepted: v3 moves Zitadel
from Apache-2.0 to AGPL-3.0 (run unmodified, nothing to publish). Watch for
Login V2 changes to the login surface users see. Both compose files move
together (digest parity is tested) and the deploy compose change needs
`node scripts/ci/deploy-assets-manifest.mjs --write` in the same commit.

## 2. Extraction hardening: kill the schema flake, then raise the floors back

The one remaining source of red live-eval runs: at temperature 0, on long
documents, the extraction model intermittently omits a required field
(`source_span`, once `hedged`) for one fact, the Zod schema rejects the whole
answer, and repair retries fail IDENTICALLY within the run (proved 2026-08-16:
the omission is correlated, not a dice roll). One flaked case swings a
small-denominator vertical metric past its floor. The fix is quality work, not
gate tuning: revise the extraction prompt and/or schema so a malformed single
fact cannot fail the whole case (candidates: strengthen the span instruction,
or drop-and-log the individual malformed fact instead of rejecting the case,
which must respect "extraction fabricates nothing" and the suppressed-fact
log). This is a versioned prompt change: new prompt artifact under
`project/prompts/`, `npm run eval:cache:refresh` in the same change, golden-set
gates must hold. When the flake is dead, RATCHET THE FLOORS BACK UP
(`project/eval/gates.json`), reversing the 2026-08-16 lowerings recorded in
`docs/eval/gate-model.md`. In the same neighbourhood, when prompts are open
anyway: the consistently failing cases hr-rw05/06/10 (temporal classification,
declension of a reply target) and the chat rule misses on `atlas_scope` and
`who_is_ana` are the named quality gaps.

## 3. Node 22 to 24, before April 2027

Node 22 is Maintenance LTS until 2027-04-30. The move is one deliberate
change: all node image pins (both composes, infra and mail Dockerfiles, six
pin sites), `engines` in the root package.json, `@types/node` (currently
ignore-listed at major 22 in dependabot.yml, update the ignore), full suite,
compose smoke. Do it alone, in a quiet week.

## Standing loops, no action needed

Silo (object store): on each upstream release, diff-review the fork, mirror
the digest to `cogeto/silo`, bump the pin (`docs/notes/dependabot-triage.md`
records the procedure and the audit). Garage remains the pre-scouted exit;
its missing SSE-S3 API would need the encryption assertion redesigned.
Trust-score releases: publish from a clean live recording run; a one-off red
gets one re-roll (`docs/eval/gate-model.md`, closing addendum).

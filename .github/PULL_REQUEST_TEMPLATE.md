<!-- Title must be a Conventional Commit (feat:/fix:/chore:/docs:/refactor:/test:/ci:)
     — we squash-merge, so your title becomes the commit on main and a release-notes line. -->

## What and why

<!-- The change and its reasoning. Link issues: Closes #N (one per issue). -->

## Checklist

- [ ] `npm run lint`, `npm run boundaries`, `npm run test`, `npm run build` pass locally
- [ ] New/changed behavior is tested (integration tests use real containers via Testcontainers)
- [ ] Docs updated where behavior contradicts them; notable decisions get a `docs/decisions/` record
- [ ] Any golden-set/eval cases added use **fictional data only** (docs/eval-golden-set.md)
- [ ] No memory content, secrets, or tokens in logs or fixtures
- [ ] First contribution? The CLA bot will ask you to sign with **one comment** — see [CONTRIBUTING.md](../CONTRIBUTING.md#the-cla-honestly)

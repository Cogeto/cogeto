# Contributing to Cogeto

Thanks for considering it. Cogeto is a small, deliberate codebase with binding
architecture rules — this page is the outsider's distillation of how work
lands. The full internal versions: [`docs/engineering-workflow.md`](docs/engineering-workflow.md)
(the delivery loop) and [`AGENTS.md`](AGENTS.md) (the non-negotiable
engineering rules — worth reading before any memory/retrieval/pipeline change).

## The delivery loop

1. **Open or find an issue** describing the change. Small, logically separated
   issues beat one giant one.
2. **Branch** from `main`: `feature/<slug>`, `fix/<slug>`, or `chore/<slug>`
   (short, kebab-cased).
3. **Implement.** Match the surrounding code: TypeScript strict mode, Zod at
   every boundary, names from [`docs/glossary.md`](docs/glossary.md), never
   memory content or tokens in logs.
4. **Open a pull request** with a [Conventional Commit](https://www.conventionalcommits.org/)
   title — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:` —
   because we **squash-merge**: your PR title becomes the single commit on
   `main` and a line in the release notes. Link issues with `Closes #N`.
5. **Five required checks must be green** before merge:

   | Check        | What it enforces                                          |
   | ------------ | --------------------------------------------------------- |
   | `lint`       | ESLint + Prettier (+ shellcheck on the operator script)   |
   | `boundaries` | the module map — no module touches another's tables       |
   | `test`       | Vitest unit + Testcontainers integration suites           |
   | `build`      | backend compile + frontend build                          |
   | `eval-gate`  | the golden-set gate — quality regressions fail the build  |

6. A maintainer squash-merges. Releases are cut separately by the maintainer
   tagging (see [`docs/release-process.md`](docs/release-process.md)); CI never
   tags.

## Running the checks locally

Prereqs: Node 22, Docker (integration tests start real Postgres/Qdrant/MinIO
via Testcontainers).

```sh
npm ci
npm run lint          # ESLint + Prettier
npm run boundaries    # dependency-cruiser module map
npm run build         # shared → server → web
npm run test          # all workspaces (integration suites need Docker)
```

The full end-to-end check is the repo's standing contract: `docker compose up`
on a fresh clone must reach the login page (see
[`docs/running-locally.md`](docs/running-locally.md)).

## The eval harness and the golden set

Cogeto measures itself: prompt, model, or pipeline changes are scored against a
golden corpus, and regressions **fail the build** (thresholds in
`project/eval/gates.json` ratchet up only). Run it locally with a Mistral API
key:

```sh
MISTRAL_API_KEY=... npm run eval        # extraction + verification + reconciliation
MISTRAL_API_KEY=... npm run eval:chat   # scripted conversations, end to end
```

Pull requests run a mocked build-only eval path (no key needed, forks work);
the live gate runs on `main` after merge.

**Golden-set contribution rules** (binding; full spec in
[`docs/eval-golden-set.md`](docs/eval-golden-set.md)):

- **Fictional data only.** No real people, companies, addresses, or events —
  ever. Cases read like real work notes but are invented.
- Follow the corpus format and labeling rules in the spec (expected facts,
  verification verdicts, temporal anchors); English and Croatian cases are
  both welcome.
- A case that a model "should" pass but doesn't is a *good* contribution —
  gates only ratchet when quality actually improves.

## Prompts and decisions

- Every prompt that decides what Cogeto remembers is a **versioned artifact**
  in `project/prompts/` — numbered, immutable once released, changelogged.
  Never edit a released prompt in place; add a new version.
- Notable decisions (structure, dependencies, schema commitments, renames) get
  a numbered record in [`docs/decisions/`](docs/decisions/) — short, honest,
  stating what was decided and why. Read the neighboring records for the tone.
- New dependencies need maintainer sign-off before the PR.

## The CLA, honestly

Contributions require signing the [Contributor License Agreement](CLA.md)
(a CLA bot will prompt you on your first PR). The plain reason: Cogeto's core
is **AGPLv3**, and the company behind it (MVT Solutions Group d.o.o.) also
offers **commercial licenses** to organizations that cannot accept AGPL terms —
that dual-licensing is what funds the open core. Legally, we can only offer
your contribution under both licenses if you grant us that permission; that is
all the CLA does. You keep your copyright and can use your own contribution
however you like. If that trade-off isn't acceptable to you, we'd rather you
know before writing code than after.

## Code of conduct

Participation in the project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md). Be a professional; report issues to the
contact listed there.

## Security issues

Never open a public issue for a vulnerability — see [`SECURITY.md`](SECURITY.md)
for private reporting.

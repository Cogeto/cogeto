# The Ana sandbox

A pre-populated fictional world that demonstrates the **actual system**: same
endpoints, same pipeline, same guarantees, on fictional data. It is the reference
demonstration of the system, so its rules are fixed.

```sh
COGETO_DEMO_MODE=1 docker compose --profile demo up --build
```

## Access is password-gated

The seed provisions, idempotently, a real machine user in the instance's org (the demo
Principal, *Ana Kovač*) and mints a real bearer token for it. That token resolves
through the unchanged auth guard exactly like a human login: **no auth bypass is
introduced.**

The sandbox is **not** open to anonymous visitors. The seed generates a strong random
password, writes it to the demo volume, and prints it in the job logs. The config
endpoint advertises that demo mode and a login exist but **never returns the token**;
a separate endpoint takes the username and password, verifies them with a
length-guarded constant-time compare, and only then returns the session. Both endpoints
**fail closed** on a production or non-demo instance, exposing nothing and leaking no
existence. The SPA shows a small login form.

This is an **application credential, not a second identity system**. It authenticates
into Ana's existing session rather than minting a per-visitor identity, which is
acceptable for a single-tenant, disposable sandbox.

**Password lifecycle**: a container restart reuses the persisted password, so the
operator's known password keeps working. Every reset, manual or scheduled, rotates it
and reprints it.

## Everything is mutable, and resets restore it

Visitors do everything a real user can: capture notes, chat and remember, correct and
re-scope memories, resolve the contradiction in Review, and delete Ana's contract for
the deletion-receipt moment. Nothing is read-only.

State restores two ways: an on-demand reset, and a scheduled reset every six hours that
is appended to the worker crontab **only** in demo mode. Both tear down all demo data
and re-seed through the same pipeline. Ana's user id and token are preserved across a
reset, so an open tab keeps working.

## The seed goes through the public API

The corpus is fed **only** through the public HTTP API, never direct memory-table
inserts. That makes the seed a continuous integration test of the real system.

**The seed asserts its end state and fails loudly** if the fictional world did not
materialize as designed. A silently wrong sandbox is worse than none.

## Fictionality

All sandbox data is fictional and authored for the sandbox; it contains no real
person's data. Ana Kovač, Marko, Marta, Luka, Petra, Adriatic Foods, Atlas CRM, and
Baltic Retail are fictional and used consistently with the golden set's persona. In the
golden set the note-taker refers to Ana in the third person; in the sandbox the visitor
**is** Ana, so the same corpus is written in the first person.

The demo corpus lives under `project/demo/` and is **separate from the golden set**. It
is never scored by the eval harness and never changes gate numbers.

## It never boots on a customer instance

A startup assertion shared by every demo entrypoint **refuses to run the seed or reset**
when a production flag is set or when demo mode is not enabled. A production instance
that somehow received the demo profile fails loudly at boot rather than seeding
fictional data into real infrastructure.

## Security consequences, stated plainly

- **The demo profile must never share infrastructure with a customer instance.** A
  leaked demo credential must be able to reach nothing but fictional data. This is a
  deployment invariant, not a code check.
- The demo Principal is a low-privilege machine user with no project roles. It owns its
  fictional memories and nothing else.
- Never run the demo profile on an instance holding real data.

# Inbound email: sender authentication and anti-spoofing

Cogeto can capture memory from forwarded email. That makes the inbound address a
trust boundary: if anyone could send mail that *claims* to be from a person you
trust and have it captured, they could inject false memory into an account. This
document explains how that is prevented, what the residual limits are, and how to
verify it on a live instance.

Placeholders below: `<your-domain>` is the instance domain, so the inbound
address is `capture@in.<your-domain>` and the mail host is `mail.<your-domain>`.
`you@provider.example` stands for a registered user's real mailbox.

## The core idea: authenticate the envelope, ignore the visible "From"

Every email carries two sender identities:

- **The envelope sender** (SMTP `MAIL FROM`): what the receiving server sees at
 the protocol level, and what SPF authenticates against the connecting server's
 IP.
- **The `From:` header**: the pretty name your mail client displays. It is
 trivially forgeable and SPF does **not** check it.

Cogeto routes capture on the **envelope sender**, and treats a sender as
authenticated only when **SPF returns `pass`** for that same envelope sender. The
visible `From:` header is not trusted for routing. So forging the header alone
achieves nothing: the message is routed and authenticated as whatever the
envelope actually was.

## The gates, in order

An inbound message passes through these checks (see
`project/src/connectors/email-intake.service.ts`):

1. **Size cap**: oversized messages are refused before parsing.
2. **Hard SPF failure**: if SPF for the envelope sender is `fail` **or**
 `softfail`, the message is refused immediately, before the body is even
 parsed. (Refusing on `softfail`, not just `fail`, is deliberately stricter
 than typical mail servers.)
3. **Per-sender rate cap**: bounds how much ingestion one sender can drive.
4. **Recipient validation**: only the instance's configured inbound address is
 accepted; every other recipient is rejected at `RCPT`.
5. **Sender-routed recipients:**
 - **Self-route** (a message from a *registered user's own* address routes to
 that user) requires a positive SPF **`pass`**. A spoofed `From` can never
 self-inject into someone's account.
 - **Allowlist** (a sender a user has explicitly added) captures a copy for
 that user. This path requires that the message was *not* a fail/softfail:
 so its strength depends on the **sender's domain publishing SPF**.
 - **Neither** → refused (closed by default). The bootstrap admin account never
 captures.

The SPF verdict itself is produced by the mail server and carried to the app:
the Haraka `spf` plugin evaluates SPF and writes a `Received-SPF` header
(`project/services/mail/haraka/config/plugins`), `cogeto_deliver.js` forwards the
result as an `x-cogeto-spf` header on the internal intake call, and the app reads
it in `email-intake.controller.ts`. Sender authentication is **on by default**
(`COGETO_MAIL_REQUIRE_SPF` defaults to enabled).

## What this protects against (and what it does not)

**Protected:** a stranger on any server forging a trusted address as the envelope
sender. If that address's domain publishes SPF (every major provider and
essentially every business domain does), the forgery resolves to fail/softfail
and is refused before anything is stored. This holds even for an **allowlisted**
address: the allowlist does not weaken SPF; SPF runs first.

**Residual limits, worth understanding:**

- **SPF only protects domains that publish it.** If you allowlist an address at a
 domain with *no* SPF record, a forgery of that address is not hard-refused
 (it resolves to `none`, not `fail`). It still cannot self-inject into a
 registered account (that needs `pass`), but it could land via the allowlist.
 **Only allowlist contacts whose domains publish SPF.**
- **SPF authorizes a domain, not a single mailbox.** Anyone able to send through
 a domain's own mail servers passes SPF for that domain, so SPF alone does not
 stop one user impersonating a colleague *within the same domain*. The domain is
 the trust boundary.
- **The displayed `From:` can still be cosmetically wrong** on an accepted
 message. It is not an injection vector (routing and storage use the
 authenticated envelope), but keep it in mind when reading a captured message.

## Verifying it on a live instance

The refusal path and the accept path are tested from opposite directions.

**Refusals, from any machine with outbound port 25 open** (many home and cloud
networks block outbound 25; if `nc -vz aspmx.l.google.com 25` fails, yours does,
and you must test from elsewhere):

```
# Forge a trusted sender from an unauthorized host -> refused (SPF)
swaks --server mail.<your-domain> --port 25 --from you@provider.example --to capture@in.<your-domain> --body test

# Wrong recipient -> refused at RCPT
swaks --server mail.<your-domain> --port 25 --from you@provider.example --to stranger@in.<your-domain> --body test
```

The first is refused with `550 sender not accepted` because the connecting IP is
not in the sender domain's SPF; the dashboard's **"Recently refused"** panel shows
the reason (`spf_failed`). The second is refused at `RCPT` (`unknown recipient`).

**Accept, must come from the real provider.** A raw client can never pass SPF for
a provider it does not belong to, so a successful capture can only be shown by
forwarding a real message **from the actual mailbox** (`you@provider.example`) to
`capture@in.<your-domain>`. It arrives from the provider's own servers, passes
SPF, and appears as a source with memories within a minute or two.

Refused-forgery plus captured-real-message is the complete proof that the gate
discriminates correctly.

## The message body is treated as hostile markup

An allowlisted sender is not a trusted author: the sender gate decides *whose*
mail is remembered, never that its content is safe. Two independent layers stand
between a message body and the owner's session (security audit 2.0, SEC-7).

**A parser-based allowlist sanitizer at intake.** The retained display HTML used
to be filtered with five regexes, and the audit demonstrated two working
bypasses of them: `<img/src=x/onerror=alert(1)>` (the handler strip required
whitespace before `on`, while HTML's before-attribute-name state accepts `/`)
and `href="javas&#99;ript:..."` (the scheme neutralizer matched the literal
text, and the browser decodes the entity afterwards). Both are the same mistake:
a regex reasons about bytes, the browser reasons about the parse tree. The regex
path is **removed**, not patched. The markup is parsed with the same tree
construction a browser uses and rebuilt from an explicit allowlist by DOMPurify,
which decides on the parsed node: an `onerror` attribute is dropped because it
*is* one, however it was written, and an `href` is dropped because its *decoded*
scheme is not allowed. Everything that executes, navigates or embeds is absent
by construction rather than removed by a rule.

**A sandboxed frame at render.** The drawer used to write the stored HTML into
the page directly. It now renders inside an iframe with no `allow-scripts` and
no `allow-same-origin`, carrying its own `default-src 'none'` policy. So script
does not run whatever got through, the frame cannot read the session token or
the surrounding DOM, forms cannot post, and no remote request of any kind can be
issued from it. Links still open in a new tab. Remote images stay blocked, as
they were, so tracking pixels do not fire.

The two layers are deliberately independent: a future bypass of the sanitizer
lands somewhere it cannot execute, and a browser that ignored the sandbox would
still be handed markup with nothing executable in it.

## Where this lives in the code

- Body sanitizer: `project/src/connectors/email-parse.ts` (`sanitizeHtml`),
 tests in `email-parse.spec.ts` (both demonstrated bypasses plus a hostile corpus)
- Sandboxed rendering: `project/web/src/components/email-body.ts`, tests in
 `email-body.spec.ts`
- Intake gate and routing: `project/src/connectors/email-intake.service.ts`
- Envelope vs header resolution: `project/src/connectors/email-parse.ts`
- SPF evaluation + forwarding: `project/services/mail/haraka/` (`config/plugins`,
 `plugins/cogeto_deliver.js`)
- Intake endpoint (reads the SPF verdict): `email-intake.controller.ts`
- Tests: `email-intake.integration.spec.ts`, `email-allowlist.integration.spec.ts`,
 `mail-intake.guard.spec.ts` (co-located under `project/src/`, run in CI)
- Design rationale: decisions
 `0028-inbound-email-design` and
 `0031-sender-routed-inbound-email`

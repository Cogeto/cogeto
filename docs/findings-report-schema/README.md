# Findings report: the published format

The findings report (V2.3 item 6.2) is a signed artifact a quality lead or an
auditor can forward and act on without ever opening Cogeto. It exists in two
formats produced from ONE payload, so they cannot diverge:

- **PDF**: the human-readable document.
- **JSON**: the machine-readable artifact this directory specifies. It is the
  SIGNED RECORD; the PDF is a faithful rendering of it and carries the same
  identifier, hash and signature values on its verification page.

Like the passport schema, this directory is the public contract: the schema
for each published version, this procedure, and a fictional sample. The
in-code authority is `project/src/reports/report-format.ts`; a spec test
regenerates the schema from it and compares, so drift fails the build.

## Files

| File | What it is |
|---|---|
| `1.1/findings-report.schema.json` | **Current.** JSON Schema (draft 2020-12) for the whole artifact: `{ findings_report_version, payload, integrity }`. |
| `1.1/sample/findings-report.json` | A complete, fictional, schema-valid example. |
| `1.0/findings-report.schema.json` | The first published version. Still valid for every 1.0 artifact. |
| `1.0/sample/findings-report.json` | Its sample. |

## Versioning

`findings_report_version` inside the artifact names the format version. The
version list published here only ever grows; a change bumps the version and
publishes a new directory, and old versions stay verifiable forever (the
passport rule).

**1.1** (V2.5 item 8.3, projects as workspaces) is additive over 1.0: the
`report.scope` block gained `project_id` and `project_name`, and its `kind`
gained `project`, so a report generated for one client's project says which
client it is about and lists exactly that project's sources. Nothing about the
integrity block, the canonicalization or the signing procedure changed, so a
1.0 artifact verifies today by exactly the same procedure, against the 1.0
schema.

## Format invariants a verifier may rely on

1. **Integers only.** No number anywhere in `payload` is fractional. Rates
   (for example the published trust metrics) travel as decimal strings such
   as `"0.824"`. This is what makes the canonical bytes reproducible by any
   JSON implementation.
2. **Canonicalization** is `sorted-keys-compact-json`: serialize `payload`
   with object keys sorted lexicographically (by code point) at every depth,
   arrays in order, no whitespace, UTF-8, no unicode normalization. This is
   exactly the deletion-receipt canonicalization, and `jq -cjS` reproduces it.
3. **Hash**: `payload_sha256` is the SHA-256 of those canonical bytes, hex.
4. **Signature**: ed25519 over the ASCII hex hash STRING (not the raw bytes),
   base64-encoded. This is the deletion-receipt signing convention, so one
   documented procedure covers both.
5. Quoted spans are verbatim in the source's original language, except ASCII
   control characters (other than newline and tab), which are replaced with
   spaces at assembly time.

## Verify a report (using only this directory and standard tools)

Given a downloaded `report.json`:

```sh
# 1. Schema: validate report.json against the schema directory whose name
#    matches .findings_report_version (1.1 for reports generated today).

# 2. Canonicalize the payload and hash it.
jq -cjS .payload report.json | shasum -a 256
#    Compare with .integrity.payload_sha256 (and with the hash printed on the
#    PDF's verification page: they are the same value).

# 3. Verify the signature over the hex hash string.
jq -r .integrity.public_key_pem report.json > pub.pem
jq -r .integrity.signature report.json | base64 -d > sig.bin
printf '%s' "$(jq -r .integrity.payload_sha256 report.json)" > hash.txt
openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in hash.txt -sigfile sig.bin
# → "Signature Verified Successfully"

# 4. Confirm the key is the instance's: compare pub.pem with the response of
#    GET /api/instance/public-key on the instance that produced the report,
#    or with a copy of that key obtained at any earlier time.
```

A verifier who also holds the instance's deletion receipts can check both
with the same key: the receipt chain procedure is documented in
`docs/passport-schema/README.md` and `docs/security/deletion-and-receipts.md`.

## What verification proves, and what it does not

A valid signature proves the artifact was produced by the instance holding
that private key and has not been altered since. It does NOT prove the
underlying documents say what the report quotes: for that, the report gives
you the document name, revision and location of every quoted span, precisely
so you can open the two documents yourself. A report you cannot check against
its sources would be the kind of confident-sounding artifact Cogeto exists to
refute.

## Lifecycle and availability

A generated report is downloadable for 24 hours (the passport retention
decision, applied consistently), and is **expired immediately** when any
source belonging to its owner is deleted: the artifacts' object keys join the
deletion receipt (`findings_reports_expired` count), the bytes are erased by
the deletion worker, the nightly sweep verifies them absent, and the download
endpoint refuses with the reason. The run RECORD (scope, counts, integrity
metadata; never quoted content) survives for the delta view. A forwarded copy
naturally survives outside the instance; that is what the signature is for.

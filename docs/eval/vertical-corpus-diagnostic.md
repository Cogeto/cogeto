# What the first real-document ingestion revealed

*V2.3 item 6.4. The vertical corpus was pushed through a full ingestion on a
scratch instance BEFORE a single case was labelled. This is the report of what
that showed. It is a deliverable of item 6.4 in its own right, not a side
effect, and several of the findings below are work for later versions rather
than for this one.*

**Nothing here changed application behaviour.** Item 6.4 is evaluation and
gating only. Every defect below is recorded, reproduced where possible against
the corpus, and left for the version that owns it.

## How it was run

A dedicated scratch stack (`docker compose -p cogeto-vertical`, fresh volumes,
demo mode on, Mistral-routed to `mistral-default`, which is the configuration
every gate floor is calibrated on). Documents entered through the **real public
HTTP API**, `POST /api/files`, the same path a user's upload takes, and the
results were read from the owner's own rows afterwards. No harness shortcuts.

The two Narodne novine regulations entered as text captures rather than file
uploads, for a reason that is itself finding 6 below.

**How far it got, stated plainly.** Eight of the thirteen documents completed
their trip through the instance: the EU tender notice, Regulation (EU) 2017/745,
Regulation (EU) 2023/607, NIST SP 800-171 r2 and r3, both Raspberry Pi
datasheets and the 1987 scan. The run was **stopped** during the ninth (the
Croatian text of the MDR), which had by then spent about fifty minutes in
`extracting`. The five documents not completed are the Croatian MDR and its
amendment, the two Narodne novine regulations and the Croatian tender notice.

That is a real limit on this report and it is stated rather than glossed:
**every finding below about Croatian material comes from the eval harness**,
which runs the same anchor, extract, verify and reconcile stages over the same
excerpts, rather than from the full instance. Nothing was inferred from the
English documents and applied to the Croatian ones. What the stopped run cost is
the storage-and-retrieval half of the picture for Croatian documents, which is
worth repeating when someone has an hour to spare and no eval competing for the
same API key.

## The findings, worst first

### 1. A malformed structured output makes a large document cost three full passes, and can lose it entirely

The single most consequential thing this run found.

On the three largest documents the extraction call returned a fact object with
`source_span` missing, twice in a row, and the whole `ingestion.pipeline` job
failed:

```
Failed task 4 (ingestion.pipeline, 313401.60ms, attempt 1 of 3) with error
'structured output failed schema validation twice:
 facts.5.source_span: Invalid input: expected string, received undefined'
```

Three consequences, in increasing order of seriousness.

**a. There is no per-chunk resumption.** A retry re-runs the entire document.
Regulation (EU) 2017/745 is 175 pages, about 110 chunks; each attempt took 5 to
13 minutes and cost a full pass over every chunk. The act consumed three
attempts, roughly 28 minutes of model time, to produce one ingestion. NIST
SP 800-171 r2 failed once and succeeded on the second attempt (754 seconds);
r3 failed its first attempt too. **The failure is intermittent and per-chunk,
and the unit of retry is the document.** One bad response in a hundred chunks
costs a hundred chunks.

**b. The refusal is correct and the blast radius is not.** Extraction fabricates
nothing, so refusing a fact with no `source_span` is exactly right (AGENTS.md:
a parse or model failure produces zero memories, never an invented one). What is
wrong is that one unusable fact out of a chunk's handful discards the other
ninety-nine chunks' work as well.

**c. Two of the five large documents ended with nothing stored, on jobs recorded
as successful.** After the third attempt graphile logged
`Completed task 4 (ingestion.pipeline, 810741.30ms, attempt 3 of 3) with
success`, and the instance holds, for that document:

| Evidence | State |
|---|---|
| `file_read_report` | present, `read`, 175 pages, no reason code |
| `source_context` (anchoring) | **absent**, although the worker logged `source context anchored` on all three attempts |
| `memory` rows | **zero** |
| `suppressed_fact_log` rows | **zero** |
| `extraction_gate_refusal` rows | zero (no gate was configured) |
| `ingestion_progress` | stuck at **`extracting`**, last updated seven minutes before the job was recorded complete |

NIST SP 800-171 Revision 3 is in the same state by a different route: 120 pages
read, no `source_context`, **no memories**, and `ingestion_progress` reading
`storing`, which is the last stage. Its predecessor revision, read from a nearly
identical document, stored 100. Two of the five large documents in this corpus
therefore ended their ingestion holding nothing.

So the document a buyer would consider the most representative in the whole
corpus read perfectly, anchored, and contributed nothing, while its card would
show it still extracting. That is the "done with zero facts" shape V2.1 item 4.1
set out to abolish on the reading side, surviving on the extraction side for
very large documents.

**The mechanism is not asserted here**, because this run does not prove one; the
observation is. It is the first thing to investigate in whichever version picks
this up, and the reproduction is one command: fetch the corpus and upload
`mdr-2017-745-en.pdf`.

**What it argues for:** chunk-level durability, so a document's completed chunks
survive a retry; a per-chunk refusal that lands in `suppressed_fact_log` and
lets the rest of the document through, exactly as an unverifiable fact already
does; and a terminal state that can never read `extracting` after the job has
finished.

### 2. Real documents hand back document machinery, and that is where precision goes

On the EU tender notice the extractor produced, among 74 admitted facts:

- "The notice subtype is 17."
- "The OJ S issue number is 52/2026."
- "The registration number of BEW Berliner Energie und Wärme GmbH is
  3e025792-5ba4-4a12-b748-7f0a00ef8429."
- "The postal address of Vergabekammer des Landes Berlin is Martin-Luther-Str.
  105, Berlin, 10825, Germany."
- "The notice is officially available in English."

Every one is true, well formed, faithfully quoted and worthless. A tender notice
is roughly half template: exclusion grounds copied from the directive, eSender
contact blocks, version UUIDs, NUTS codes, form types.

This is not a bug to fix in a prompt at the end of an eval item; it is the
central quality question for the document wedge, and the vertical corpus is now
where it is measured. `LABELLING.md` section 1 makes it explicit ("would a
reader be worse off if this were missing from an index of the document?"), and
case `en-v010` is that page with exactly one label on it.

**Consequence, stated in advance:** extraction precision on the vertical corpus
is materially lower than on the core corpus, and most of the gap is this. The
alternative, labelling the machinery so it matches, would produce a flattering
number and certify behaviour nobody wants.

### 3. Anchoring is the strongest thing on documents, and it over-reaches to the document default

The good half first, because it is genuinely good. On real documents the
anchoring stage from V2.1 item 4.2 got the document class and the revision right
every time it ran, confidently:

| Document | Subjects (confident) | Class | Revision |
|---|---|---|---|
| TED 178149-2026 | REB Lot 4c, REB Lot 4d, Projekt Reuter Electrical Backbone, BEW Berliner Energie und Wärme GmbH | `contract` | `178149-2026` |
| Regulation (EU) 2023/607 | Regulation (EU) 2023/607, 2017/745, 2017/746 | `regulation` | `2023/607` |
| NIST SP 800-171 r2 | NIST SP 800-171r2 | `specification` | `Revision 2` |

It even separated the two tender lots as distinct confident subjects, which is
the exact distinction the negative pairs `en-vr07` and `en-vr11` depend on.

The other half: **the document default wins too often.** Counting the subject
stamped on every stored fact:

| Subject | Facts |
|---|---|
| NIST SP 800-171r2 | 97 |
| Projekt Reuter Electrical Backbone | 28 |
| Regulation (EU) 2023/607 | 24 |
| (none) | 16 |
| BEW Berliner Energie und Wärme GmbH | 13 |
| REB, Lot 4d | 5 |
| REB, Lot 4c | 4 |

The anchoring precedence rule is: a fact's own text outranks the section
heading, which outranks the document default. In practice the document default
took almost everything. The tender notice's two lots, which the anchor
identified as separate confident subjects, ended up on nine facts between them
while twenty-eight went to the project as a whole.

**And on the densest page it does not run at all.** The tender lot description
names more than a dozen organisations, lots, standards and equipment makers in
one paragraph. The anchor call's schema caps `subjects` at 12 entries, the model
returned more, the response failed validation twice, and the anchor was
abandoned:

```
en-v009: anchor call failed (structured output failed schema validation twice:
 subjects: Too big: expected array to have <=12 items); extracting without context
```

The degradation is correct and was designed for (spec 1.5.2: a failed anchor
call degrades to no context rather than failing the case), so the document still
extracted. But the failure mode is backwards: the pages with the MOST subjects
are the ones where anchoring is worth the most, and they are the ones where a
cap on the subject list throws the whole context away. Truncating the list would
be strictly better than discarding it.

**And it is not stable enough to gate.** Five `subject_entity` declarations were
written into the corpus to hold the anchored subject under the zero-tolerance
`subject_mismatches` gate. The Croatian ones failed on the first live run
(`null` on a regulation's list items, the document title on its amendment, an
unmatched fact on a tender lot). The two English tender-lot ones held on two
runs and failed on the third, stamping "Projekt Reuter Electrical Backbone" on a
Lot 4c fact. All of those were removed, each with its reason recorded in the
case and in the corpus changelog, because the governing rule forbids a gate the
project is currently failing and forbids a gate inside a metric's run-to-run
band. **Three remain**, on the two datasheets, and those held on all three runs.

**Why it matters for the wedge:** contradiction detection keys on subject
equality. A corpus where 97 facts share one subject is a corpus where any two
numbers in the standard are candidates for conflict with each other, and where
the section a value belongs to has been thrown away. The vertical corpus turns
this into gates: `en-v006` and `en-v008` declare `subject_entity` under the
zero-tolerance `subject_mismatches` gate precisely so this cannot drift further
without failing a build.

### 4. The quantity parser does not know the units that documents use

V2.3 item 6.1 gave the reconciler a deterministic numeric arm. Fed the actual
strings from these documents, `ingestion/domain/quantity.ts` parses this much:

| String, verbatim from a corpus document | Parsed |
|---|---|
| `400 kV` | yes, 400000 V |
| `12.000 MHz` | yes, 12 MHz |
| `16 %` | yes |
| `3,5 m` (Croatian decimal comma) | yes, 3.5 m |
| `2 472 344,00 EUR` (Croatian group separator) | yes |
| `-40 °C` (U+00B0 DEGREE SIGN) | yes |
| `-40 ºC` (U+00BA MASCULINE ORDINAL, as printed in the RP2040 datasheet) | **no** |
| `15 m²` | **no** |
| `30 ppm` | **no** |
| `50 Ω` | **no** |
| `3.0 pF` | **no** |
| `200 μW` | **no** |
| `500 MΩ` | **no** |
| `300 MVA` | **no** |
| `1,5 kg/m²` | **wrong**: parses as 1.5 kg, a mass |

Three separate problems, in order of how badly they bite.

**a. `1,5 kg/m²` parsing as a mass is worse than not parsing.** A comparison
between two areal densities becomes a comparison between two masses, which can
produce a confident wrong verdict rather than an abstention. Croatian
construction regulations are full of these.

**b. `ºC` and `°C` are different codepoints and both render as a small raised
circle.** The RP2040 datasheet uses one, the RP2350 datasheet uses the other,
for the same specification table of the same crystal. Nobody reading either
would notice. Pair `en-vr05` requires those two facts to merge.

**c. Square metres are absent, and areas dominate Croatian planning documents.**
`hr-v004` alone carries seven of them. Pair `hr-vr07` deliberately puts two of
them against each other so the corpus measures what the judge does when the
deterministic arm can contribute nothing at all.

None of this is fixed here. It is a named follow-up, and the corpus now has the
cases that prove a fix when one lands.

### 5. Real document sets contain far fewer plain contradictions than synthetic ones

Worth stating because it changes what a findings report is for.

Across thirteen real documents, including two pairs of near-identical
datasheets, two revisions of one standard and one regulation with its amending
act, the corpus yielded:

- **many supersessions** (a revision replacing a value or withdrawing a
  requirement): four labelled pairs;
- **many legitimate differences that look exactly like conflicts** (different
  part, different lot, different condition, different slot, different
  precision): fourteen labelled negatives;
- **two plain contradictions**, and both are cross-language.

There is **no genuine differing-unit, same-dimension conflict about one subject**
anywhere in the corpus, and **no plain, non-supersession contradiction in
English**. Both gaps are recorded in `project/eval/vertical/CHANGELOG.md` rather
than filled with something invented, and the consequence is stated wherever the
numbers are published: vertical contradiction recall rests on a denominator of
two.

The product implication is larger than the corpus one. **What a document set
actually contains is stale facts and near-misses, not disagreements.** A
findings report earns its keep by being right about the near-misses, which is
why precision, and the fourteen negatives that measure it, matter more here
than recall.

### 6. Two carrier formats a customer will bring are not read

**HTML.** Croatian regulations are published by Narodne novine as HTML. The
reader seam covers PDF, DOCX, XLSX, CSV and images, so the two Croatian
regulations could not be uploaded as documents at all; they entered this run as
text captures, and the corpus records the mechanical HTML-to-text conversion
that produced their excerpts. A customer whose regulator publishes to a web
portal is in exactly this position. (Cogeto fetches web pages through the
research path, which is a different thing from filing a regulation as a source
document.)

**A whole component datasheet.** Its text layer is 1,318,236 characters for the
RP2040 and 2,765,233 for the RP2350, against a `maxTextChars` cap of 1,000,000,
so both are refused. The cap is defensible and the refusal is honest, but "a
datasheet" is one of the four document types this product is sold against, and
the two in this corpus both exceed it. The corpus works around this the only
honest way available: its datasheet cases are verbatim page excerpts, and the
whole-file refusal is recorded here rather than engineered around. See 6b.

### 6b. Both datasheets and the scan are refused before any model call, and one refusal is worded alarmingly

The three largest files never reached extraction at all, and the reader said so
honestly on `file_read_report`, which is the reading layer from V2.1 item 4.1
working as designed:

| Document | Outcome | Reason |
|---|---|---|
| RP2040 datasheet (5.3 MB) | `read_failed` | `text_over_cap` |
| RP2350 datasheet (8.0 MB) | `read_failed` | `text_over_cap` |
| NBS SP 250-3, the 1987 scan (6.7 MB) | `read_failed` | **`parse_timeout`** |

Two things to take from it.

**The scan times out, it does not merely decode badly.** The 30-second parse cap
(`timeoutSeconds: 30`) is not enough for a 141-page scanned PDF, so the document
never gets as far as the OCR-quality question that finding 7 describes. The
corpus reaches that question only because its cases are page excerpts. A
customer uploading a scanned archive hits the timeout first.

**The over-cap refusal is logged as a suspected attack.** The worker error reads:

```
extracted text (2765428 chars) exceeds the 1000000-char cap
 (possible decompression bomb)
```

That is a published component datasheet from Raspberry Pi. The cap is right and
the refusal is right; the parenthetical is a security heuristic's wording
reaching an ordinary user's document, and it will read badly in a log an
operator shows a customer.

**The retry behaviour is correct here**, and worth contrasting with finding 1:
these are permanent errors, so the job dead-letters after three attempts and the
file's read report records the reason, which is exactly the design. The
difference is that these documents END in a stated failed state, and the two in
finding 1 end in a state that says `extracting` forever.

### 7. A real scan behaves exactly as the reading ladder predicts, which is the good news

NBS Special Publication 250-3 (1987) is a genuine scan with an OCR text layer.
Of its 141 pages, 17 carry under 200 characters, and the worst of them decode to
character debris:

```
o
(/)
a
{-
73
```

That is page 58, a rotated figure. Page 34 of the same document is clean enough
to read, with tab characters injected between every word and one mis-decoded
token (`MgFp` for `MgF2`), and it carries a real measurement ("The window is
located 17 cm from the arc").

The corpus keeps both as cases: `en-v011` must extract **nothing** from the
debris, and `en-v012` must extract five facts from the noisy page. The pair is
the point. A system that treats a file as one quality level gets one of the two
wrong, and a 1987 archive is the customer document set most likely to exist.

The ladder's own tier decision on these pages is not gated, because gating it
would need a vision model in CI, which V2.1 item 4.1 deliberately did not add.

### 8. Verification abstains on document prose more than on notes

Of the facts admitted in this run, 26 were admitted `uncertain` with reason
`unjudgeable`, against 175 admitted active. Sampling them, they are
overwhelmingly the machinery of finding 2 (postal addresses, procedural
inadmissibility rules) plus long conditional legal sentences.

`unjudgeable` is the honest outcome and the automatic-admission path from V2.0
item 3.3 handles it correctly. The observation is the rate: on document prose
the verifier declines to judge roughly one fact in eight. That is a measurable
quantity now, through the vertical corpus's verification agreement figure, and
it is the first number to watch if the verifier is ever split so that a correct
demotion of a bad extraction stops counting against it (a gap V2.0 item 3.4
named and nobody has scheduled).

## What this seeds for later versions

Recorded in the plan under item 6.4 so it is not lost:

1. **Chunk-level durability in the ingestion pipeline** (finding 1). The
   largest single-document risk this run found.
2. **A terminal state that cannot read `extracting`** after the job finished
   (finding 1c).
3. **Section-level subject anchoring that survives to the fact** (finding 3).
4. **The unit table the documents actually use**, and an areal-density parse
   that is not silently a mass (finding 4).
5. **An HTML reader** (finding 6), and a decision about whole-datasheet
   documents against the text cap.
6. **Authority ranking**, whose four cases are authored and pending in
   `project/eval/vertical/authority/`, including the one no pair comparison can
   answer: a change notice that says the specifications are stale without saying
   what replaced them.

## Reproducing this

```sh
node project/eval/vertical/fetch.mjs          # the originals, verified by checksum
docker compose -p <scratch> --profile demo up -d --build app worker
# then upload each original through POST /api/files as an authenticated owner
```

The corpus manifest (`project/eval/vertical/documents.json`) carries the URL,
publisher, licence, retrieval date and SHA-256 of every document, so anyone can
repeat this against the same bytes.

# The vertical corpus

*V2.3 item 6.4. Real public documents of the type Cogeto is sold into, labelled
by hand, run by the same harness as the core corpus and reported separately from
it.*

## Why it exists

The engine was proven on notes and emails. The claim being sold is about
document sets, and until this corpus existed nothing measured that. A buyer
looking at the trust page could read an extraction precision figure and have no
way to know it was measured on quick captures rather than on the regulations,
standards and datasheets they were about to feed it.

**Everything here is a real, publicly available document.** Nothing was written
for the corpus. Model-written fixtures are cleaner and more internally
consistent than real ones: they have no page furniture, no tables flattened by a
PDF text layer, no registry metadata that is true and worthless, no 1987 scan
whose OCR turned a rotated figure into character debris. A corpus of them
flatters the system and proves nothing.

## What is in it

| Documents | 13 (8 English, 5 Croatian) |
| Extraction cases | 20 (12 en, 8 hr) |
| Reconciliation pairs | 24 (12 en, 7 hr, 5 cross-language) |
| Labelled cases, total | **44** |
| Authored but PENDING | 4 authority-ranking pairs, not loaded, see [`authority/`](authority/) |

Four document types, chosen so the corpus exercises what the pipeline actually
finds hard:

- **Regulatory guidance**: Regulation (EU) 2017/745 (medical devices) in English
  and Croatian, plus Regulation (EU) 2023/607, which amends its transitional
  provisions. Two Croatian construction regulations from Narodne novine, one of
  them the amendment of the other.
- **Standards and technical files**: NIST SP 800-171 Revisions 2 and 3, a live
  standard and the revision it replaced, with four requirements withdrawn
  between them.
- **Device datasheets**: the Raspberry Pi RP2040 and RP2350, two microcontrollers
  whose datasheets share their boilerplate almost word for word and whose
  numbers differ.
- **Public tender and requirements specifications**: an EU transformer
  procurement notice with electrical ratings and tolerances, and a Croatian
  Ministry of the Interior notice for protective masks with three lots that
  differ only by product class.
- **A scan**: NBS Special Publication 250-3 from 1987, digitised with an
  imperfect OCR text layer, so the reading ladder meets real degraded input
  rather than a clean render.

Everything about every document, including its licence, is in
[`documents.json`](documents.json).

## Croatian material: what is native and what is not

The plan asked for Croatian-language material where a suitable public source
exists, and asked plainly for a statement if none was found rather than a
substitution of translations. Both kinds are here and the manifest labels each:

- **Croatian-origin, written in Croatian by Croatian bodies**: the Pravilnik o
  jednostavnim i drugim građevinama i radovima (Narodne novine 112/2017) and its
  2022 amendment, and the TED notice whose contracting authority is the Croatian
  Ministry of the Interior and whose original language is Croatian.
- **Croatian authentic language versions of EU acts**: the MDR and its amending
  regulation. Under EU law every language version is equally authentic, so these
  are neither machine translations nor unofficial ones. They are still
  translations of a text drafted elsewhere, and `documents.json` sets
  `croatian_origin: false` on them with the reason. They are included because
  the cross-language pairs need the SAME act in both languages, which no pair of
  independently authored documents can give.

## Licensing and provenance

Every document records its source URL, publisher, licence or terms, retrieval
date and SHA-256. **The original bytes are never committed**: about 27 MB of
third-party PDFs do not belong in a source repository, and a URL plus a checksum
is a stronger provenance claim than a copied file because it can be re-verified
against the publisher. Re-download and verify them with:

```sh
node project/eval/vertical/fetch.mjs
```

**What IS committed is the text excerpt each case runs on**, produced by
Cogeto's own reader from those bytes. Every document in the manifest carries a
licence that permits redistribution of the work in whole or in part:

| Basis | Documents |
|---|---|
| Commission Decision 2011/833/EU (EUR-Lex and TED reuse, with source acknowledged) | the MDR, its amending act, both tender notices |
| Work of the United States Government, 17 U.S.C. section 105 | NIST SP 800-171 r2 and r3, NBS SP 250-3 |
| CC BY-ND 4.0, which grants reproduction and sharing **in whole or in part** | the RP2040 and RP2350 datasheets |
| Not subject to copyright: Zakon o autorskom pravu i srodnim pravima (NN 111/21) article 18(3), official texts published for official public information | both Narodne novine regulations |

A document whose licence did not permit an excerpt would have been referenced by
URL alone, with its cases dropped rather than the corpus quietly reshaped around
it. None was needed. **The CC BY-ND constraint binds the corpus**: those two
excerpts are verbatim reader output and must never be edited, tidied or
paraphrased, because adapted material is exactly what that licence withholds.
[`LABELLING.md`](LABELLING.md) section 6 makes that a corpus-wide rule for a
second reason, which is that tidying is the flattery this corpus exists to
avoid.

**Attribution.** RP2040 Datasheet and RP2350 Datasheet, copyright Raspberry Pi
Ltd, licensed CC BY-ND 4.0. EUR-Lex and TED content, copyright European Union,
reused under Decision 2011/833/EU; only EU legislation printed in the paper
edition of the Official Journal is deemed authentic.

## Layout

```
project/eval/vertical/
  documents.json     provenance manifest: url, publisher, licence, date, sha256
  fetch.mjs          re-download and verify the originals
  originals/         gitignored; what fetch.mjs writes
  LABELLING.md       the labelling rules, written before the first label
  CHANGELOG.md       one line per label change
  cases/             THE CORPUS THE HARNESS LOADS
    en/  hr/  xl/    extraction cases and pair cases
  authority/         authored, PENDING, deliberately outside cases/
```

`cases/` exists so the corpus root can hold the manifest, the fetch script and
the pending cases without any of them being mistaken for a language: both
loaders treat every directory under the corpus root as one.

`xl` is the cross-language pair set, English against Croatian on one act. It is
a measured set like a language and it is gated like one.

## How it runs

The same harness, the same thresholds, the same scoring:

```sh
npm run eval          # core corpus, then the vertical corpus, both printed
npm run eval:gate     # the same with the floors enforced
npm run eval:cached   # replayed against the committed fixtures (what CI runs on a PR)
```

The vertical numbers are **never averaged into the core ones**. Averaging a hard
new corpus into a mature one hides both signals: the aggregate looks worse
without explaining why, and the vertical result becomes unreadable. Its floors
live in a `vertical` block of [`../gates.json`](../gates.json) and are justified
in [`../../../docs/eval/gate-model.md`](../../../docs/eval/gate-model.md) on the
same terms as every other floor: the honest current value, ratchet up only,
never a target the project sits below.

The published trust artifact carries both corpora side by side from schema 1.2
on, under `configurations[].corpora`, so a reader can see accuracy on documents
specifically.

## What the first ingestion of these documents revealed

The corpus was pushed through a full ingestion on a scratch instance before a
single case was labelled. That diagnostic is a deliverable of item 6.4 in its
own right and it is written up in
[`../../../docs/eval/vertical-corpus-diagnostic.md`](../../../docs/eval/vertical-corpus-diagnostic.md).
Several cases in this corpus exist because of what it found.

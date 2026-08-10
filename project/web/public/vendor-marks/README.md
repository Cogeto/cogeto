# Third-party provider marks

The marks in this directory identify **model providers** in the provider and
model-assignment surfaces (V2.4 item 7.1). They are **not** Cogeto brand assets:
Cogeto's own logo lives in [`assets/brand/`](../../../../assets/brand/) and is
governed by [`TRADEMARK.md`](../../../../TRADEMARK.md). Nothing here is licensed
under this repository's AGPL; each mark stays the property of its owner.

Three rules bind every file here.

1. **Unmodified.** Files are byte-for-byte as retrieved. No recolouring, no
   restyling, no cropping, no `invert()` filter, no effects. Verify with the
   recorded SHA-256 before and after any change to this directory.
2. **Identification only.** A mark appears at icon size beside the provider's
   name, never larger or more prominent than Cogeto's own marks, and never in a
   position that could read as endorsement, partnership or affiliation. Cogeto
   is not a partner, reseller or affiliate of any provider listed here.
3. **Provenance is recorded, including when it is imperfect.** Where a file did
   not come from the brand owner's own published resource, the table below says
   so in those words. A stated gap is a decision; a silent one is a claim.

## Assets

| File | Mark | Source | Retrieved | SHA-256 |
|---|---|---|---|---|
| `openai-blossom-black.svg` | OpenAI Blossom, black | `https://cdn.openai.com/brand/openai-logos.zip`, entry `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg`: OpenAI's own downloadable logo kit | 2026-08-10 | `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a` |
| `openai-blossom-white.svg` | OpenAI Blossom, white | the same archive, entry `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg` | 2026-08-10 | `01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285` |
| `anthropic-icon.png` | Anthropic glyph, black on transparent | Streamline (`assets.streamlinehq.com`), **not an Anthropic resource**: see below | 2026-08-10 | `16603fe96f198659ffe5df2fa63409613abc776520609a6afcfea311776e0884` |
| `mistral-icon.png` | Mistral pixel-cat icon, gradient | LobeHub icon set (`raw.githubusercontent.com/lobehub/lobe-icons`, `packages/static-png/dark/mistral-color.png`), **not the Mistral kit**: see below | 2026-08-10 | `f3b97d586f84e68b8031c74b34bebe4651ee0cb130831ac9b97cb64e1820a2ef` |

## How they are rendered

Two of these are published as a **single dark-on-transparent file**, which would
disappear on the dark surface. Rather than recolour or invert a mark, which every
guidance here forbids, all three vendor marks are drawn on a **constant light
tile** in both themes. A background is not a modification, and "use on a light
background" is what the guidance asks for anyway; it is also the one treatment
that works identically for all three, so the set reads as one system instead of
three exceptions.

That is why the black OpenAI Blossom is the variant in use. Its published white
counterpart is kept beside it because the pair is what OpenAI publishes, and a
future reversed treatment should not need a second download.

## Provenance and terms, per mark

**OpenAI.** From OpenAI's own published logo kit. Used under the OpenAI Brand
Guidelines (`https://openai.com/brand/`), whose conditions the three rules above
restate: the mark exactly as provided, never more prominent than your own marks,
and never in a way that implies a relationship OpenAI has not agreed to. Uses
beyond the guidelines require OpenAI's written permission, which Cogeto has not
sought and does not claim.

**Anthropic.** This file is **not from an Anthropic brand resource**. No public
Anthropic brand or press asset page resolves (`/brand`, `/brand-guidelines`,
`/press`, `/legal/trademark*` all return 404), so there is no published
third-party identification form to take and no published terms to record. What
ships here is Streamline's rendering of the Anthropic glyph. Two separate rights
are therefore in play: **Anthropic's trademark** in the mark, used here only to
identify Anthropic as a provider an operator can point this instance at, and
**Streamline's own copyright** in the drawing, which their asset licence governs.
Replace this file with an official Anthropic asset the moment one is published.

**Mistral.** Mistral publishes a brand kit at `https://mistral.ai/brand` and
states that partners and collaborators are welcome to use the brand responsibly,
with an explicit misuse list: do not stretch, deform, rotate, modify the layout,
recolour, use on a coloured background, frame, or use old or unofficial versions.
The file here is **a third-party re-export from the LobeHub icon set, not a file
taken from that kit**: the kit's host refuses non-browser requests, so it could
not be downloaded here, and this copy may not be the current official version. It
is used unmodified, at icon size, on a light tile, which respects every item on
that list that is ours to respect. Replace it with `Icon Gradient` from Mistral's
own kit when that download is possible.

## Changing a mark

Download the file from the owner's own brand resource, drop it in here
**unmodified**, update its row above with the new source, retrieval date and
SHA-256, and point `MARK_FILES` in
`project/web/src/components/ProviderMark.tsx` at it. Anything not listed in
`MARK_FILES` falls through to a neutral labelled placeholder, which is a correct
answer rather than a gap.

**Self-hosted deliberately has no logo.** It is drawn as a rack glyph in the
design system's own line style, at the same optical stroke weight as the rest of
the iconography, and deliberately given no tile, because the contrast carries the
meaning: three companies and one you.

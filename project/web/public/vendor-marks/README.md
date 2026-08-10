# Third-party provider marks

The marks in this directory identify **model providers** in the provider and
model-assignment surfaces (V2.4 item 7.1). They are **not** Cogeto brand assets:
Cogeto's own logo lives in [`assets/brand/`](../../../../assets/brand/) and is
governed by [`TRADEMARK.md`](../../../../TRADEMARK.md). Nothing here is licensed
under this repository's AGPL; each mark stays the property of its owner.

Three rules bind every file here.

1. **Unmodified.** Files are byte-for-byte as published. No recolouring, no
   restyling, no cropping, no effects, no redrawing. Verify with the recorded
   SHA-256 before and after any change to this directory.
2. **Identification only.** A mark appears at icon size beside the provider's
   name, never larger or more prominent than Cogeto's own marks, and never in a
   position that could read as endorsement, partnership or affiliation. Cogeto
   is not a partner, reseller or affiliate of any provider listed here.
3. **No improvisation.** Where a mark cannot be obtained from the owner's own
   published brand or press resources under terms that cover this use, the
   interface shows a **neutral labelled placeholder** instead, and the reason is
   recorded below. A placeholder is a correct answer; a hand-drawn imitation is
   not.

## Assets

| File | Mark | Source | Retrieved | SHA-256 |
|---|---|---|---|---|
| `openai-blossom-black.svg` | OpenAI Blossom, black | `https://cdn.openai.com/brand/openai-logos.zip` (`OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg`), linked from the OpenAI brand site | 2026-08-10 | `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a` |
| `openai-blossom-white.svg` | OpenAI Blossom, white | same archive, `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg` | 2026-08-10 | `01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285` |

The black and white pair is the reversed form OpenAI publishes; the interface
picks one per theme and applies no filter to either.

**Terms.** OpenAI publishes these files as its downloadable logo kit and permits
use under its Brand Guidelines (`https://openai.com/brand/`), whose conditions
this directory's three rules restate: use the mark exactly as provided, never
more prominently than your own marks, and never in a way that implies a
relationship OpenAI has not agreed to. Uses beyond the guidelines require
OpenAI's written permission, which Cogeto has not sought and does not claim.

## Placeholders, and why

| Provider | Why there is no mark here |
|---|---|
| **Mistral** | Mistral publishes a brand kit at `https://mistral.ai/brand` and states that partners and collaborators are welcome to use the brand responsibly. The asset host (`cms.globalaegis.net`) refuses non-browser requests, so the files could not be obtained from the publisher's own resource. Rather than take a copy from a third-party logo aggregator, whose provenance and currency cannot be verified and whose files may be an old or unofficial version Mistral's own guidance forbids, the interface shows a neutral placeholder. |
| **Anthropic** | No public brand or press asset page resolves (`/brand`, `/brand-guidelines`, `/press`, `/legal/trademark*` all return 404), so there is no published third-party identification form to use, and no published terms to record. The interface shows a neutral placeholder. |

To replace a placeholder later: download the official file from the owner's own
brand resource, drop it in here **unmodified**, add its row to the table above
with the retrieval date and SHA-256, and add the filename to `MARK_FILES` in
`project/web/src/components/ProviderMark.tsx`. Nothing else needs to change.

**Self-hosted** deliberately has no logo. It is drawn as a rack glyph in the
design system's own line style, at the same stroke weight as the rest of the
iconography, because the contrast carries the meaning: three companies and one
you.

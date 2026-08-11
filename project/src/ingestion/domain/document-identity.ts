/**
 * The commercial document identifier as a subject (issue #498;
 * docs/features/document-identity.md, frozen before this file). A pure
 * function: given a claim, return the document identifier it is anchored to,
 * or null. Used at stage-5 admission ONLY for facts whose subject_entity is
 * null, so a model- or anchor-resolved subject is never overridden (spec
 * 1.5.2: mechanical resolution may only reduce ambiguity).
 */

/** Document words in the two corpus languages, longest first so
 * "račun-otpremnica" wins over "račun". Case-insensitive, diacritic-exact:
 * the claim quotes the document, and the document spells its own word. */
const DOCUMENT_WORDS = [
  'račun-otpremnica',
  'racun-otpremnica',
  'delivery note',
  'quotation',
  'narudžba',
  'narudzba',
  'invoice',
  'ponuda',
  'offer',
  'order',
  'račun',
  'racun',
];

/** An identifier token: digits with optional separators and suffixes, the
 * shapes real documents print ("020260455", "233/01", "118-01-261 R1",
 * "2026-0771", "412/02"). Must contain at least one digit. */
const IDENTIFIER = String.raw`(?:No\.?\s*|br\.?\s*)?([A-Z]{0,4}[-/]?\d[\d./-]*(?:\s?R\d)?)`;

const PATTERN = new RegExp(
  `\\b(${DOCUMENT_WORDS.map((w) => w.replace(/[.^$*+?()|[\]{}\\]/g, '\\$&')).join('|')})` +
    `\\s+${IDENTIFIER}`,
  'iu',
);

/**
 * The identifier a claim is anchored to, verbatim as the claim writes it
 * ("Invoice 2026-0771", "Ponuda 233/01", "Račun-otpremnica 118-01-261"), or
 * null when the claim names no numbered commercial document. The document
 * word keeps its claim casing; nothing is normalised here, because a subject
 * is copied text, and the alias fold downstream handles case.
 */
export function documentIdentityOf(claim: string): string | null {
  const match = PATTERN.exec(claim);
  if (!match) return null;
  const word = match[1]!;
  const id = match[2]!;
  // A bare year or a lone small number is not an identifier; require either
  // a separator or four or more digits, which every observed real identifier
  // has, and which "3 pieces" and "invoice 2 weeks" shapes never do.
  const digits = id.replace(/\D/g, '');
  if (digits.length < 4 && !/[-/.]/.test(id)) return null;
  return `${word} ${id}`.replace(/\s+/g, ' ').trim();
}

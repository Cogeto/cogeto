/**
 * Entity matching beyond byte-equality (V2.3 item 6.1, issue A). Before this
 * module, two facts could pair for a contradiction check only when their
 * subject entities were byte-equal after lowercasing, so an alias, a typo, or
 * a cross-language name ("Adriatic Foods" vs "Jadranska hrana") could never
 * contradict. Three layers, all deterministic and pure:
 *
 * 1. **Folding**: case, punctuation, whitespace, diacritics, and legal-form
 *    suffixes are presentation, not identity. "Adriatic Foods d.o.o." and
 *    "adriatic-foods doo" fold to the same key.
 * 2. **Aliases**: recorded equivalences (the ingestion-owned `entity_alias`
 *    table) resolved through a union of folded names. Cross-language identity
 *    is data, not an algorithm: no folding rule can know the Croatian name of
 *    an English company, so the alias set is the mechanism that pairs them,
 *    and it can grow.
 * 3. **Typo tolerance**: one edit, only in long-enough names, and never at a
 *    token start. "adriatic fods" is a typo of "adriatic foods"; "Adriatic
 *    Goods" is a different company whose difference IS the token-initial
 *    letter. Aliasing is exactly where false pairs come from, so the rule is
 *    deliberately narrower than a generic edit distance.
 *
 * Honesty note recorded here because issue A demands it: the redaction NER
 * sidecar is English-only (`en_core_web_lg`), but nothing in this module
 * depends on it. The entities matched here are the extraction model's, which
 * is multilingual; the NER limitation affects which names get pseudonymized
 * when redaction is enabled, not which facts can pair. When redaction IS
 * enabled, Croatian names the English NER misses embed unpseudonymized, which
 * changes similarity scores, not this module's matching.
 */

/** A recorded equivalence: both sides are entity names as the user wrote them. */
export interface EntityAliasPair {
  canonical: string;
  alias: string;
}

/** Characters NFD decomposition cannot fold (they are not combining marks). */
const LETTER_FOLDS: Record<string, string> = {
  đ: 'd',
  ð: 'd',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ł: 'l',
  ø: 'o',
};

/**
 * Trailing legal-form tokens stripped AFTER punctuation folding ("d.o.o." has
 * become "doo"). Stripped only while at least one token remains: a company
 * actually named "AG" keeps its name.
 */
const LEGAL_SUFFIXES = new Set([
  'doo',
  'dd',
  'jdoo',
  'gmbh',
  'ag',
  'ltd',
  'llc',
  'inc',
  'corp',
  'co',
  'plc',
  'sa',
  'srl',
  'sro',
  'oy',
  'ab',
  'bv',
  'nv',
  'kft',
  'zrt',
]);

/**
 * Case, punctuation, whitespace, diacritic and legal-suffix folding — the
 * deterministic half of entity identity. Pure and total: '' in, '' out.
 */
export function foldEntityName(name: string): string {
  const lowered = name.trim().toLowerCase();
  const unaccented = lowered
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đðßæœłø]/g, (ch) => LETTER_FOLDS[ch] ?? ch);
  const tokens = unaccented
    .replace(/&/g, ' and ')
    // Periods are abbreviation markers ("d.o.o.", "U.S."): removed, so the
    // letters collapse into one token instead of splintering into three.
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(' ');
}

/**
 * Alias resolution: folded names grouped by union over the recorded pairs.
 * `keyOf` returns the group representative for a name (its own fold when no
 * alias touches it), so two names are alias-equivalent iff their keys match.
 */
export class EntityAliasIndex {
  /** folded name -> group representative (the smallest folded member). */
  private groups = new Map<string, string>();

  constructor(pairs: readonly EntityAliasPair[] = []) {
    // Union-find over folded names, path-compressed at build time.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== undefined && parent.get(root) !== root) {
        root = parent.get(root)!;
      }
      return root;
    };
    for (const pair of pairs) {
      const a = foldEntityName(pair.canonical);
      const b = foldEntityName(pair.alias);
      if (!a || !b || a === b) continue;
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    }
    const members = new Map<string, string[]>();
    for (const name of parent.keys()) {
      const root = find(name);
      members.set(root, [...(members.get(root) ?? []), name]);
    }
    for (const group of members.values()) {
      const representative = [...group].sort()[0]!;
      for (const name of group) this.groups.set(name, representative);
    }
  }

  /** The canonical key for a raw entity name: fold, then alias-resolve. */
  keyOf(name: string): string {
    const folded = foldEntityName(name);
    return this.groups.get(folded) ?? folded;
  }

  /**
   * Every recorded name equivalent to `name` (folded forms, the name's own
   * fold included) — the expansion the candidate SEARCH uses, so a fact about
   * the Croatian name can find rows stored under the English one.
   */
  expand(name: string): string[] {
    const key = this.keyOf(name);
    const out = new Set<string>([foldEntityName(name)]);
    for (const [member, representative] of this.groups) {
      if (representative === key) out.add(member);
    }
    out.delete('');
    return [...out];
  }
}

export const EMPTY_ALIAS_INDEX = new EntityAliasIndex();

/** Minimum folded length before the one-edit typo rule may apply at all. */
const TYPO_MIN_LENGTH = 8;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/**
 * True when `a` and `b` differ by exactly one edit (substitution, insertion,
 * or deletion) that does NOT touch the first character of any token and does
 * NOT involve a digit. A typo lands mid-word in letters; a token-initial
 * difference ("Foods" vs "Goods") is how two genuinely different names look,
 * and a digit difference ("PWR-3100" vs "PWR-3200") is how two SIBLING
 * PRODUCTS look — both are exactly the false pairs this rule must never
 * produce.
 */
export function isOneMidTokenEdit(a: string, b: string): boolean {
  if (a === b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;
  if (shorter.length < TYPO_MIN_LENGTH) return false;
  const tokenStart = (s: string, i: number) => i === 0 || s[i - 1] === ' ';
  let i = 0;
  // Walk to the first disagreement; the edit position is there or nowhere.
  while (i < shorter.length && shorter[i] === longer[i]) i += 1;
  if (i === shorter.length) {
    // Pure append of one character at the very end of the longer string.
    return !tokenStart(longer, i) && !isDigit(longer[i]);
  }
  if (tokenStart(shorter, i) || tokenStart(longer, i)) return false;
  if (isDigit(shorter[i]) || isDigit(longer[i])) return false;
  if (shorter.length === longer.length) {
    // Substitution: the rest must agree exactly.
    return shorter.slice(i + 1) === longer.slice(i + 1);
  }
  // Insertion/deletion: skip the extra character in the longer string.
  return shorter.slice(i) === longer.slice(i + 1);
}

/**
 * The pairing decision: same entity for reconciliation purposes. Folding and
 * aliases first (exact after normalization), the narrow typo rule last.
 */
export function entityNamesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
  aliases: EntityAliasIndex = EMPTY_ALIAS_INDEX,
): boolean {
  if (!a || !b) return false;
  const keyA = aliases.keyOf(a);
  const keyB = aliases.keyOf(b);
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  return isOneMidTokenEdit(keyA, keyB);
}

/**
 * |A∩B| / min(|A|,|B|) over canonical keys — the alias-aware upgrade of the
 * dedup candidate gate's entity overlap. 0 when either set folds to nothing.
 */
export function canonicalEntityOverlap(
  a: readonly string[],
  b: readonly string[],
  aliases: EntityAliasIndex = EMPTY_ALIAS_INDEX,
): number {
  const keysA = new Set(a.map((n) => aliases.keyOf(n)).filter((k) => k.length > 0));
  const keysB = new Set(b.map((n) => aliases.keyOf(n)).filter((k) => k.length > 0));
  if (keysA.size === 0 || keysB.size === 0) return 0;
  let shared = 0;
  for (const key of keysA) if (keysB.has(key)) shared += 1;
  return shared / Math.min(keysA.size, keysB.size);
}

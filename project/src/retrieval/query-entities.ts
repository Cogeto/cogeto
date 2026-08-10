import { QUERY_ENTITY_STOPWORDS } from './retrieval-config';

/**
 * An IDENTIFIER token: letters and digits mixed in one word (`m557`, `M557`,
 * `rp2040`, `sen-210`, `800-171r3`). Case carries no information in this shape,
 * so it is a candidate however the user typed it.
 *
 * Why this exists (issue #477). The capitalization heuristic below is a
 * reasonable proxy for a PERSON or ORGANISATION name and a poor one for a part
 * number, which users type lowercase constantly. On the live instance
 * `what is m557?` contributed NO deterministic candidate, so naming fell to the
 * model rewrite, which supplied `m557` on some turns and nothing on others. The
 * turns where it supplied nothing answered "I have nothing about this in your
 * sources" over fifteen matching facts. A deterministic rule removes the coin
 * flip: if the user typed the identifier, the identifier is named.
 *
 * Deliberately narrow. A pure word ("brass") and a pure number ("2027") are NOT
 * identifiers; only the mixed shape is, which is what a part, model, standard
 * or revision number looks like across every document type in the corpus.
 */
const IDENTIFIER_RE = /^(?=[\p{L}\p{N}'’-]*\p{L})(?=[\p{L}\p{N}'’-]*\p{N})[\p{L}\p{N}'’-]+$/u;

/** Exported for the unit suite; not part of the module's public interface. */
export function isIdentifierToken(token: string): boolean {
  return IDENTIFIER_RE.test(token);
}

/**
 * The fast-path query-entity heuristic (v1, spec §3.4): capitalized tokens and
 * IDENTIFIER tokens are candidate names — no model call. The actual "matched
 * against known entities" happens in SQL, where entitySearch trigram-matches
 * these candidates against the stored entities of memories the principal may
 * see. A false candidate ("Thursday") simply matches nothing there.
 */
export function queryEntityCandidates(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const names: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) names.push(run.join(' '));
    run = [];
  };
  for (const token of tokens) {
    const first = token.charAt(0);
    const capitalized = first !== first.toLowerCase() && first === first.toUpperCase();
    // An identifier joins a capitalized run when it follows one ("Fuze M557"),
    // and stands alone otherwise ("what is m557?"). Stopwords cannot reach it:
    // no stopword mixes letters and digits.
    if (
      (capitalized || isIdentifierToken(token)) &&
      !QUERY_ENTITY_STOPWORDS.has(token.toLowerCase())
    ) {
      run.push(token); // consecutive capitalized tokens form one name ("Nova Gradiška")
    } else {
      flush();
    }
  }
  flush();
  return [...new Set(names)];
}

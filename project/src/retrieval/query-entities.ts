import { QUERY_ENTITY_STOPWORDS } from './retrieval-config';

/**
 * The fast-path query-entity heuristic (v1, §A.5): capitalized tokens are
 * candidate names — no model call. The actual "matched against known entities"
 * happens in SQL, where entitySearch trigram-matches these candidates against
 * the stored entities of memories the principal may see. A false candidate
 * ("Thursday") simply matches nothing there.
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
    if (capitalized && !QUERY_ENTITY_STOPWORDS.has(token.toLowerCase())) {
      run.push(token); // consecutive capitalized tokens form one name ("Nova Gradiška")
    } else {
      flush();
    }
  }
  flush();
  return [...new Set(names)];
}

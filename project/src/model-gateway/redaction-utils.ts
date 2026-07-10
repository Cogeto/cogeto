/**
 * Pure re-identification (decision 0023). Reversal is deterministic string
 * substitution, so the gateway does it locally from the mapping the sidecar
 * returned — no second network hop, and it composes with streaming. Mirrors the
 * sidecar's `reidentify` (project/services/redaction/app/redactor.py).
 */

/** Replace each pseudonym with its original. Slots are bracketed (`[person1]`),
 * so an exact string swap is unambiguous — `[person1]` is never a substring of
 * `[person10]`, and it can only ever match a slot the sidecar minted, never a
 * user's own text. `split/join` avoids any regex `$`/backslash interpretation.
 * Longest first as defence against any unforeseen overlap. */
export function reidentifyText(text: string, mapping: Record<string, string>): string {
  const tokens = Object.keys(mapping).sort((a, b) => b.length - a.length);
  let out = text;
  for (const token of tokens) {
    out = out.split(token).join(mapping[token]!);
  }
  return out;
}

/** Re-identify every string in a parsed structured result (extraction output). */
export function reidentifyDeep<T>(value: T, mapping: Record<string, string>): T {
  if (typeof value === 'string') return reidentifyText(value, mapping) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => reidentifyDeep(item, mapping)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = reidentifyDeep(val, mapping);
    return out as T;
  }
  return value;
}

/**
 * Re-identify a token stream without splitting a pseudonym across chunks: flush
 * only up to the last whitespace (a complete-token boundary), keep the trailing
 * partial token buffered, and flush the remainder at end-of-stream.
 */
export async function* reidentifyStream(
  source: AsyncIterable<string>,
  mapping: Record<string, string>,
): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of source) {
    buffer += chunk;
    const boundary = Math.max(buffer.lastIndexOf(' '), buffer.lastIndexOf('\n'));
    if (boundary >= 0) {
      const flush = buffer.slice(0, boundary + 1);
      buffer = buffer.slice(boundary + 1);
      yield reidentifyText(flush, mapping);
    }
  }
  if (buffer) yield reidentifyText(buffer, mapping);
}

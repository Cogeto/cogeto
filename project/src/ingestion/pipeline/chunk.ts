/**
 * Stage 2 (chunk). Chunks exist to fit accurate extraction into the model's
 * attention span — they are transient values, never rows (glossary; research:
 * retrieval-and-pipeline §3). Sources under the threshold pass through as one
 * chunk; longer inputs get simple length-based chunks with overlap so facts
 * spanning a boundary appear whole in at least one chunk.
 */

export interface Chunk {
  text: string;
  index: number;
}

/** ~1.5k tokens — well inside the extraction model's context. */
export const CHUNK_MAX_CHARS = 6000;
export const CHUNK_OVERLAP_CHARS = 500;

export function chunkContent(
  content: string,
  maxChars: number = CHUNK_MAX_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
): Chunk[] {
  const text = content.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [{ text, index: 0 }];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Prefer a whitespace boundary in the tail of the window over mid-word cuts.
      const window = text.slice(start, end);
      const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
      if (lastBreak > maxChars * 0.5) end = start + lastBreak;
    }
    chunks.push({ text: text.slice(start, end), index: chunks.length });
    if (end >= text.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

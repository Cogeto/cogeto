/**
 * A minimal TrueType parser (V2.3 item 6.2) — exactly what embedding a font
 * in a PDF as CIDFontType2/Identity-H needs, nothing more: the unicode→glyph
 * map (cmap formats 4 and 12), advance widths (hhea+hmtx), and the vertical
 * metrics the FontDescriptor states (head, OS/2). The font FILE is embedded
 * whole and untouched; no table is rewritten, so there is no subsetting logic
 * to get wrong. Dependency-free by design (the ZIP-walk precedent).
 */

export interface ParsedFont {
  /** The raw font file, embedded verbatim as FontFile2. */
  bytes: Buffer;
  unitsPerEm: number;
  /** Font-unit metrics, scaled by the consumer to the 1000/em PDF space. */
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  postScriptName: string;
  /** unicode code point → glyph id (0 = .notdef, the honest fallback). */
  glyphFor(codePoint: number): number;
  /** advance width in font units for a glyph id. */
  advanceOf(glyphId: number): number;
}

export function parseTtf(bytes: Buffer): ParsedFont {
  const tables = readTableDirectory(bytes);
  const head = expect(tables, 'head');
  const hhea = expect(tables, 'hhea');
  const maxp = expect(tables, 'maxp');
  const hmtx = expect(tables, 'hmtx');
  const cmap = expect(tables, 'cmap');

  const unitsPerEm = bytes.readUInt16BE(head.offset + 18);
  const bbox: [number, number, number, number] = [
    bytes.readInt16BE(head.offset + 36),
    bytes.readInt16BE(head.offset + 38),
    bytes.readInt16BE(head.offset + 40),
    bytes.readInt16BE(head.offset + 42),
  ];
  const ascent = bytes.readInt16BE(hhea.offset + 4);
  const descent = bytes.readInt16BE(hhea.offset + 6);
  const numberOfHMetrics = bytes.readUInt16BE(hhea.offset + 34);
  const numGlyphs = bytes.readUInt16BE(maxp.offset + 4);

  let capHeight = ascent;
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 90) {
    const version = bytes.readUInt16BE(os2.offset);
    if (version >= 2) capHeight = bytes.readInt16BE(os2.offset + 88);
  }

  const postScriptName = readPostScriptName(bytes, tables.get('name')) ?? 'EmbeddedFont';

  // Advance widths: entries beyond numberOfHMetrics repeat the last width.
  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    if (gid < numberOfHMetrics) {
      last = bytes.readUInt16BE(hmtx.offset + gid * 4);
    }
    advances[gid] = last;
  }

  const lookup = buildCmapLookup(bytes, cmap.offset);

  return {
    bytes,
    unitsPerEm,
    ascent,
    descent,
    capHeight,
    bbox,
    postScriptName,
    glyphFor: (codePoint) => lookup(codePoint),
    advanceOf: (glyphId) => advances[glyphId] ?? 0,
  };
}

interface TableRecord {
  offset: number;
  length: number;
}

function readTableDirectory(bytes: Buffer): Map<string, TableRecord> {
  const numTables = bytes.readUInt16BE(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    const tag = bytes.toString('latin1', base, base + 4);
    tables.set(tag, {
      offset: bytes.readUInt32BE(base + 8),
      length: bytes.readUInt32BE(base + 12),
    });
  }
  return tables;
}

function expect(tables: Map<string, TableRecord>, tag: string): TableRecord {
  const table = tables.get(tag);
  if (!table) throw new Error(`font file is missing the required '${tag}' table`);
  return table;
}

/** Prefer a UCS-4 subtable (format 12), else BMP format 4. */
function buildCmapLookup(bytes: Buffer, cmapOffset: number): (codePoint: number) => number {
  const numSubtables = bytes.readUInt16BE(cmapOffset + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < numSubtables; i += 1) {
    const base = cmapOffset + 4 + i * 8;
    const platformId = bytes.readUInt16BE(base);
    const encodingId = bytes.readUInt16BE(base + 2);
    const offset = cmapOffset + bytes.readUInt32BE(base + 4);
    const format = bytes.readUInt16BE(offset);
    const unicode =
      (platformId === 3 && (encodingId === 1 || encodingId === 10)) || platformId === 0;
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    if (format === 4 && format4 === -1) format4 = offset;
  }

  if (format12 !== -1) {
    const offset = format12;
    const nGroups = bytes.readUInt32BE(offset + 12);
    const groups: { start: number; end: number; startGlyph: number }[] = [];
    for (let i = 0; i < nGroups; i += 1) {
      const base = offset + 16 + i * 12;
      groups.push({
        start: bytes.readUInt32BE(base),
        end: bytes.readUInt32BE(base + 4),
        startGlyph: bytes.readUInt32BE(base + 8),
      });
    }
    return (codePoint) => {
      let lo = 0;
      let hi = groups.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const group = groups[mid]!;
        if (codePoint < group.start) hi = mid - 1;
        else if (codePoint > group.end) lo = mid + 1;
        else return group.startGlyph + (codePoint - group.start);
      }
      return 0;
    };
  }

  if (format4 === -1) throw new Error('font file has no usable unicode cmap subtable');
  const offset = format4;
  const segCount = bytes.readUInt16BE(offset + 6) / 2;
  const endCodes: number[] = [];
  const startCodes: number[] = [];
  const idDeltas: number[] = [];
  const idRangeOffsetsPos: number[] = [];
  const endBase = offset + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  for (let i = 0; i < segCount; i += 1) {
    endCodes.push(bytes.readUInt16BE(endBase + i * 2));
    startCodes.push(bytes.readUInt16BE(startBase + i * 2));
    idDeltas.push(bytes.readInt16BE(deltaBase + i * 2));
    idRangeOffsetsPos.push(rangeBase + i * 2);
  }
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let i = 0; i < segCount; i += 1) {
      if (codePoint > endCodes[i]!) continue;
      if (codePoint < startCodes[i]!) return 0;
      const rangeOffset = bytes.readUInt16BE(idRangeOffsetsPos[i]!);
      if (rangeOffset === 0) return (codePoint + idDeltas[i]!) & 0xffff;
      const glyphPos = idRangeOffsetsPos[i]! + rangeOffset + (codePoint - startCodes[i]!) * 2;
      const glyph = bytes.readUInt16BE(glyphPos);
      return glyph === 0 ? 0 : (glyph + idDeltas[i]!) & 0xffff;
    }
    return 0;
  };
}

function readPostScriptName(bytes: Buffer, name: TableRecord | undefined): string | null {
  if (!name) return null;
  const count = bytes.readUInt16BE(name.offset + 2);
  const stringOffset = name.offset + bytes.readUInt16BE(name.offset + 4);
  for (let i = 0; i < count; i += 1) {
    const base = name.offset + 6 + i * 12;
    const platformId = bytes.readUInt16BE(base);
    const nameId = bytes.readUInt16BE(base + 6);
    if (nameId !== 6) continue;
    const length = bytes.readUInt16BE(base + 8);
    const offset = stringOffset + bytes.readUInt16BE(base + 10);
    if (platformId === 3) {
      // UTF-16BE
      let out = '';
      for (let j = 0; j < length; j += 2)
        out += String.fromCharCode(bytes.readUInt16BE(offset + j));
      return out;
    }
    return bytes.toString('latin1', offset, offset + length);
  }
  return null;
}

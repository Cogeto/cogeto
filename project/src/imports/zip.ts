import { inflateRawSync } from 'node:zlib';

/**
 * Dependency-free ZIP enumeration and extraction (V2.2 item 5.3): the EOCD →
 * central directory → local header walk the reader seam's sniffer already
 * does for entry NAMES, extended to sizes, offsets and the two compression
 * methods a document ZIP actually contains (stored, deflate). Node's zlib
 * inflates; nothing new enters the dependency tree (a full ZIP library needs
 * owner sign-off and buys nothing here).
 *
 * Limits are the caller's: entries are enumerated lazily-cheap (no inflation)
 * and extracted one at a time.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The EOCD lives in the last 64 KiB + 22 bytes, by specification. */
const EOCD_SEARCH_WINDOW = 66 * 1024;

export interface ZipEntry {
  /** The path inside the archive, forward slashes. */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate; anything else is unsupported. */
  method: number;
  localHeaderOffset: number;
}

/** Enumerates a ZIP's file entries (directories skipped), or null when the
 * buffer is not a readable ZIP (no EOCD, ZIP64, malformed directory). */
export function zipEntries(buffer: Buffer): ZipEntry[] | null {
  const windowStart = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= windowStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffffffff || count === 0xffff) return null; // ZIP64

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localHeaderOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue; // directory
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
  }
  return entries;
}

/** Extracts one entry's bytes; throws for an unsupported method or a
 * malformed local header — the item then fails ALONE with its reason. */
export function zipExtract(buffer: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new Error(`malformed local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

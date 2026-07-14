/**
 * A minimal, dependency-free ZIP writer (STORE method, no compression).
 *
 * The Passport is a zip because it carries binary originals alongside JSON
 * (decision record §format); a hand-rolled STORE writer keeps the archive fully
 * inspectable and adds no dependency. The format is the well-documented PKZIP
 * APPNOTE: a local header + data per entry, then a central directory, then the
 * end-of-central-directory record. Any standard unzip reads it.
 *
 * Entries are stored uncompressed, so a document's bytes in the zip are byte-for
 * -byte the bytes the manifest hashed — the hash check needs no decompression.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive (e.g. `attachments/file.pdf`). */
  path: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time from a JS date (local-agnostic: we pass an explicit instant). */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate =
    (((date.getUTCFullYear() - 1980) & 0x7f) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

/**
 * Build a STORE-method zip from the entries, stamped with a single instant
 * (passed in for reproducibility). Filenames are UTF-8 (general-purpose bit 11
 * set). Not zip64 — v1 Passports are well under 4 GiB.
 */
export function createZip(entries: ZipEntry[], date: Date): Buffer {
  const { time, date: dosDate } = dosDateTime(date);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filename
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central dir size
  end.writeUInt32LE(localBuf.length, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBuf, centralBuf, end]);
}

/**
 * Read a STORE-method zip back to its entries — the inverse of {@link createZip},
 * used to inspect and verify a Passport. Walks the central directory from the
 * end-of-central-directory record; only STORE (method 0) entries are supported
 * (what this writer emits). Throws on a truncated or non-STORE archive.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  // Locate the end-of-central-directory record (signature 0x06054b50) by
  // scanning backwards — the trailing comment is always empty here.
  let end = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buffer.readUInt16LE(end + 10);
  let ptr = buffer.readUInt32LE(end + 16); // central directory offset

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(ptr + 10);
    if (method !== 0) throw new Error(`unsupported compression method ${method}`);
    const size = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const path = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // Read the local header to skip to the data (its name/extra lengths).
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ path, data: buffer.subarray(dataStart, dataStart + size) });

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

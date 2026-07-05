// Minimal STORE-only (no compression) ZIP writer. The format is a sequence of
// local file headers + data, followed by a central directory and an EOCD record.
// Store-only keeps the implementation tiny and dependency-free — browsers and OS
// file managers handle uncompressed zips transparently. CRC32 comes from Node's
// built-in zlib (available since Node 22), so there's no native dependency to
// worry about for the offline buildNpmPackage in flake.nix.
import { crc32 } from "node:zlib";

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// DOS time/date are the only timestamps a zip entry carries; use a fixed epoch
// (1980-01-01) so exports are byte-identical for identical content.
const DOS_TIME = (0 << 11) | (0 << 5) | (0 >> 1);
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data) >>> 0;
    const size = entry.data.byteLength;

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.byteLength);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true); // signature
    dv.setUint16(4, 20, true); // version needed to extract
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // compression method: stored
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true); // compressed size
    dv.setUint32(22, size, true); // uncompressed size
    dv.setUint16(26, nameBytes.byteLength, true);
    dv.setUint16(28, 0, true); // extra field length
    lfh.set(nameBytes, 30);
    localParts.push(lfh, entry.data);

    // Central directory file header (46 bytes + name)
    const cd = new Uint8Array(46 + nameBytes.byteLength);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // method
    cdv.setUint16(12, DOS_TIME, true);
    cdv.setUint16(14, DOS_DATE, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.byteLength, true);
    cdv.setUint16(30, 0, true); // extra
    cdv.setUint16(32, 0, true); // comment length
    cdv.setUint16(34, 0, true); // disk number start
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    centralParts.push(cd);

    offset += lfh.byteLength + entry.data.byteLength;
  }

  const central = concat(centralParts);

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central directory
  edv.setUint16(8, entries.length, true); // entries on this disk
  edv.setUint16(10, entries.length, true); // total entries
  edv.setUint32(12, central.byteLength, true);
  edv.setUint32(16, offset, true); // central directory offset
  edv.setUint16(20, 0, true); // comment length

  return concat([...localParts, central, eocd]);
}

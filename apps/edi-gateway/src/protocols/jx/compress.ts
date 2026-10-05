// JX leaves compression to the application (compressType = MIME type). We
// support the two the guideline lists: application/zip (single entry, e.g.
// OCCTO) and application/gzip.
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

export const ZIP = 'application/zip';
export const GZIP = 'application/gzip';
const ZIP_TYPES = [ZIP, 'application/x-zip-compressed', 'application/x-zip'];
const GZIP_TYPES = [GZIP, 'application/x-gzip'];

export function compress(type: string, data: Buffer, name = 'document.dat'): Buffer {
  if (!type) return data;
  if (ZIP_TYPES.includes(type)) return zipOne(name, data);
  if (GZIP_TYPES.includes(type)) return gzipSync(data);
  throw new Error(`unsupported compressType ${type}`);
}

/** Returns the uncompressed document (and the zip entry name, if any). */
export function decompress(type: string, data: Buffer): { data: Buffer; name?: string } {
  if (!type) return { data };
  if (ZIP_TYPES.includes(type)) return unzipFirst(data);
  if (GZIP_TYPES.includes(type)) return { data: gunzipSync(data) };
  throw new Error(`unsupported compressType ${type}`);
}

const dosTime = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d: Date) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

/** Single-entry ZIP (deflate), UTF-8 file name flag set. */
export function zipOne(name: string, data: Buffer): Buffer {
  const fname = Buffer.from(name, 'utf8');
  const comp = deflateRawSync(data);
  const crc = crc32(data) >>> 0;
  const now = new Date();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime(now), 10);
  local.writeUInt16LE(dosDate(now), 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime(now), 12);
  central.writeUInt16LE(dosDate(now), 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + fname.length, 12);
  end.writeUInt32LE(30 + fname.length + comp.length, 16);
  return Buffer.concat([local, fname, comp, central, fname, end]);
}

/** Extracts the first file entry of a ZIP (stored or deflate), using the central directory for sizes. */
export function unzipFirst(zip: Buffer): { data: Buffer; name?: string } {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a ZIP file');
  let p = zip.readUInt32LE(eocd + 16);
  const entries = zip.readUInt16LE(eocd + 10);
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad ZIP central directory');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const flags = zip.readUInt16LE(p + 8);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory
    const lNameLen = zip.readUInt16LE(localOff + 26);
    const lExtraLen = zip.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = zip.subarray(start, start + compSize);
    if (method === 0) return { data: Buffer.from(raw), name };
    if (method === 8) return { data: inflateRawSync(raw), name };
    throw new Error(`unsupported ZIP compression method ${method}`);
  }
  throw new Error('ZIP has no file entries');
}

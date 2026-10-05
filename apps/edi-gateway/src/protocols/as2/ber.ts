// Minimal BER reader / DER writer for CMS CompressedData (RFC 3274 / 5402).
import { deflateSync, inflateSync } from 'node:zlib';

interface Tlv { tag: number; constructed: boolean; value: Buffer; children?: Tlv[]; end: number }

function readTlv(buf: Buffer, pos: number): Tlv {
  const first = buf[pos];
  const constructed = (first & 0x20) !== 0;
  let p = pos + 1;
  let tag = first;
  if ((first & 0x1f) === 0x1f) {
    tag = 0;
    while (buf[p] & 0x80) tag = (tag << 7) | (buf[p++] & 0x7f);
    tag = (tag << 7) | buf[p++];
  }
  let len = buf[p++];
  if (len === 0x80) {
    // indefinite length: children until end-of-contents (0x00 0x00)
    const children: Tlv[] = [];
    while (!(buf[p] === 0 && buf[p + 1] === 0)) {
      const c = readTlv(buf, p);
      children.push(c);
      p = c.end;
    }
    return { tag, constructed, value: Buffer.alloc(0), children, end: p + 2 };
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const value = buf.subarray(p, p + len);
  const t: Tlv = { tag, constructed, value, end: p + len };
  if (constructed) {
    t.children = [];
    let q = 0;
    while (q < value.length) {
      const c = readTlv(value, q);
      t.children.push(c);
      q = c.end;
    }
  }
  return t;
}

/** Concatenates a (possibly constructed) OCTET STRING. */
function octets(t: Tlv): Buffer {
  return t.constructed ? Buffer.concat((t.children ?? []).map(octets)) : t.value;
}

function oid(t: Tlv): string {
  const b = t.value;
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      out.push(v);
      v = 0;
    }
  }
  return out.join('.');
}

const ID_CT_COMPRESSED = '1.2.840.113549.1.9.16.1.9';
const ID_ALG_ZLIB = '1.2.840.113549.1.9.16.3.8';

export function isCompressedData(der: Buffer): boolean {
  try {
    const ci = readTlv(der, 0);
    return oid(ci.children![0]) === ID_CT_COMPRESSED;
  } catch {
    return false;
  }
}

/** ContentInfo(CompressedData) -> uncompressed content bytes. */
export function uncompress(der: Buffer): Buffer {
  const ci = readTlv(der, 0);
  if (oid(ci.children![0]) !== ID_CT_COMPRESSED) throw new Error('not CMS compressed-data');
  const cd = ci.children![1].children![0]; // [0] EXPLICIT -> CompressedData SEQUENCE
  const [, alg, encap] = cd.children!;
  if (oid(alg.children![0]) !== ID_ALG_ZLIB) throw new Error('unsupported compression algorithm');
  const eContent = encap.children![1].children![0]; // [0] EXPLICIT OCTET STRING
  return inflateSync(octets(eContent));
}

// ---- DER writer ----
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, value: Buffer) => Buffer.concat([Buffer.from([tag]), len(value.length), value]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const oidDer = (s: string) => {
  const parts = s.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const v of parts.slice(2)) {
    const enc = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) {
      enc.unshift(0x80 | (x & 0x7f));
      x = Math.floor(x / 128);
    }
    bytes.push(...enc);
  }
  return tlv(0x06, Buffer.from(bytes));
};

/** content bytes -> DER ContentInfo(CompressedData, zlib). */
export function compress(content: Buffer): Buffer {
  const compressedData = seq(
    tlv(0x02, Buffer.from([0])), // version 0
    seq(oidDer(ID_ALG_ZLIB)),
    seq(oidDer('1.2.840.113549.1.7.1'), tlv(0xa0, tlv(0x04, deflateSync(content)))),
  );
  return seq(oidDer(ID_CT_COMPRESSED), tlv(0xa0, compressedData));
}

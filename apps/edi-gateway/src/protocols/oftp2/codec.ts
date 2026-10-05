// ODETTE-FTP 2.0 (RFC 5024) command codec. Field positions and widths follow
// section 5.3; strings are left-justified/space-padded, numbers right-justified/
// zero-padded, binary lengths are 2-octet network byte order.

export const CR = 0x0d;

export type Cmd =
  | { type: 'SSRM' }
  | { type: 'SSID'; level: number; code: string; password: string; sdeb: number; sr: 'S' | 'R' | 'B'; compression: boolean; restart: boolean; special: boolean; credit: number; auth: boolean; user: string }
  | { type: 'SFID'; dsn: string; date: string; time: string; user: string; dest: string; orig: string; format: 'F' | 'V' | 'U' | 'T'; lrecl: number; fileSize: number; origSize: number; restart: number; security: string; cipher: string; compression: string; envelope: string; signedEerp: boolean; description: string }
  | { type: 'SFPA'; count: number }
  | { type: 'SFNA'; reason: string; retry: boolean; text: string }
  | { type: 'DATA'; payload: Buffer }
  | { type: 'CDT' }
  | { type: 'EFID'; records: number; units: number }
  | { type: 'EFPA'; cd: boolean }
  | { type: 'EFNA'; reason: string; text: string }
  | { type: 'ESID'; reason: string; text: string }
  | { type: 'CD' }
  | { type: 'EERP'; dsn: string; date: string; time: string; user: string; dest: string; orig: string; hash: Buffer; signature: Buffer }
  | { type: 'NERP'; dsn: string; date: string; time: string; dest: string; orig: string; creator: string; reason: string; text: string; hash: Buffer; signature: Buffer }
  | { type: 'RTR' }
  | { type: 'SECD' }
  | { type: 'AUCH'; challenge: Buffer }
  | { type: 'AURP'; response: Buffer };

const CODES: Record<string, Cmd['type']> = {
  I: 'SSRM', X: 'SSID', H: 'SFID', '2': 'SFPA', '3': 'SFNA', D: 'DATA', C: 'CDT', T: 'EFID', '4': 'EFPA', '5': 'EFNA',
  F: 'ESID', R: 'CD', E: 'EERP', N: 'NERP', P: 'RTR', J: 'SECD', A: 'AUCH', S: 'AURP',
};

export class CodecError extends Error {}

// ---- field helpers ------------------------------------------------------------
const str = (v: string, n: number) => {
  const b = Buffer.from(v ?? '', 'latin1');
  if (b.length > n) throw new CodecError(`field too long (${b.length} > ${n}): ${v}`);
  return Buffer.concat([b, Buffer.alloc(n - b.length, 0x20)]);
};
const num = (v: number, n: number) => {
  const s = String(Math.max(0, Math.floor(v)));
  if (s.length > n) throw new CodecError(`number too wide for ${n} digits: ${v}`);
  return Buffer.from(s.padStart(n, '0'), 'latin1');
};
const yn = (b: boolean) => Buffer.from(b ? 'Y' : 'N');
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const text = (t: string, lenWidth: number) => {
  const b = Buffer.from(t ?? '', 'utf8');
  return Buffer.concat([num(b.length, lenWidth), b]);
};

/** Reader over a command buffer with offset bookkeeping. */
class R {
  pos = 1;
  constructor(private b: Buffer) {}
  str(n: number) {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n).toString('latin1').replace(/ +$/, '');
    this.pos += n;
    return v;
  }
  raw(n: number) {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  num(n: number) {
    const s = this.str(n).trim();
    if (!/^\d*$/.test(s)) throw new CodecError(`expected digits, got "${s}"`);
    return Number(s || '0');
  }
  yn() {
    return this.str(1) === 'Y';
  }
  u16() {
    this.need(2);
    const v = this.b.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  utf8(lenWidth: number) {
    const n = this.num(lenWidth);
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n).toString('utf8');
    this.pos += n;
    return v;
  }
  rest() {
    return this.b.subarray(this.pos);
  }
  private need(n: number) {
    if (this.pos + n > this.b.length) throw new CodecError(`command truncated at offset ${this.pos}`);
  }
}

// ---- encode -------------------------------------------------------------------
export function encode(c: Cmd): Buffer {
  const cr = Buffer.from([CR]);
  switch (c.type) {
    case 'SSRM': return Buffer.concat([Buffer.from('IODETTE FTP READY '), cr]);
    case 'SSID': return Buffer.concat([
      Buffer.from('X'), num(c.level, 1), str(c.code, 25), str(c.password, 8), num(c.sdeb, 5), Buffer.from(c.sr),
      yn(c.compression), yn(c.restart), yn(c.special), num(c.credit, 3), yn(c.auth), str('', 4), str(c.user, 8), cr]);
    case 'SFID': return Buffer.concat([
      Buffer.from('H'), str(c.dsn, 26), str('', 3), num(Number(c.date), 8), Buffer.from(c.time.padStart(10, '0')), str(c.user, 8),
      str(c.dest, 25), str(c.orig, 25), Buffer.from(c.format), num(c.lrecl, 5), num(c.fileSize, 13), num(c.origSize, 13),
      num(c.restart, 17), Buffer.from(c.security), Buffer.from(c.cipher), Buffer.from(c.compression), Buffer.from(c.envelope),
      yn(c.signedEerp), text(c.description, 3)]);
    case 'SFPA': return Buffer.concat([Buffer.from('2'), num(c.count, 17)]);
    case 'SFNA': return Buffer.concat([Buffer.from('3'), Buffer.from(c.reason), yn(c.retry), text(c.text, 3)]);
    case 'DATA': return Buffer.concat([Buffer.from('D'), c.payload]);
    case 'CDT': return Buffer.from('C  ');
    case 'EFID': return Buffer.concat([Buffer.from('T'), num(c.records, 17), num(c.units, 17)]);
    case 'EFPA': return Buffer.concat([Buffer.from('4'), yn(c.cd)]);
    case 'EFNA': return Buffer.concat([Buffer.from('5'), Buffer.from(c.reason), text(c.text, 3)]);
    case 'ESID': return Buffer.concat([Buffer.from('F'), Buffer.from(c.reason), text(c.text, 3), cr]);
    case 'CD': return Buffer.from('R');
    case 'EERP': return Buffer.concat([
      Buffer.from('E'), str(c.dsn, 26), str('', 3), Buffer.from(c.date), Buffer.from(c.time), str(c.user, 8), str(c.dest, 25), str(c.orig, 25),
      u16(c.hash.length), c.hash, u16(c.signature.length), c.signature]);
    case 'NERP': return Buffer.concat([
      Buffer.from('N'), str(c.dsn, 26), str('', 6), Buffer.from(c.date), Buffer.from(c.time), str(c.dest, 25), str(c.orig, 25), str(c.creator, 25),
      Buffer.from(c.reason), text(c.text, 3), u16(c.hash.length), c.hash, u16(c.signature.length), c.signature]);
    case 'RTR': return Buffer.from('P');
    case 'SECD': return Buffer.from('J');
    case 'AUCH': return Buffer.concat([Buffer.from('A'), u16(c.challenge.length), c.challenge]);
    case 'AURP':
      if (c.response.length !== 20) throw new CodecError('AURP response must be 20 octets');
      return Buffer.concat([Buffer.from('S'), c.response]);
  }
}

// ---- decode -------------------------------------------------------------------
export function decode(b: Buffer): Cmd {
  if (!b.length) throw new CodecError('empty exchange buffer');
  const type = CODES[String.fromCharCode(b[0])];
  if (!type) throw new CodecError(`unknown command 0x${b[0].toString(16)}`);
  const r = new R(b);
  switch (type) {
    case 'SSRM':
      if (r.str(17) !== 'ODETTE FTP READY') throw new CodecError('bad SSRM');
      return { type };
    case 'SSID': {
      const level = r.num(1);
      const code = r.str(25);
      const password = r.str(8);
      const sdeb = r.num(5);
      const sr = r.str(1) as 'S' | 'R' | 'B';
      const compression = r.yn();
      const restart = r.yn();
      const special = r.yn();
      const credit = r.num(3);
      const auth = r.yn();
      r.str(4);
      const user = r.str(8);
      return { type, level, code, password, sdeb, sr, compression, restart, special, credit, auth, user };
    }
    case 'SFID': {
      const dsn = r.str(26);
      r.str(3);
      const date = r.str(8);
      const time = r.str(10);
      const user = r.str(8);
      const dest = r.str(25);
      const orig = r.str(25);
      const format = r.str(1) as 'F' | 'V' | 'U' | 'T';
      const lrecl = r.num(5);
      const fileSize = r.num(13);
      const origSize = r.num(13);
      const restart = r.num(17);
      const security = r.str(2);
      const cipher = r.str(2);
      const compression = r.str(1);
      const envelope = r.str(1);
      const signedEerp = r.yn();
      const description = r.utf8(3);
      return { type, dsn, date, time, user, dest, orig, format, lrecl, fileSize, origSize, restart, security, cipher, compression, envelope, signedEerp, description };
    }
    case 'SFPA': return { type, count: r.num(17) };
    case 'SFNA': return { type, reason: r.str(2), retry: r.yn(), text: r.utf8(3) };
    case 'DATA': return { type, payload: r.rest() };
    case 'CDT': return { type };
    case 'EFID': return { type, records: r.num(17), units: r.num(17) };
    case 'EFPA': return { type, cd: r.yn() };
    case 'EFNA': return { type, reason: r.str(2), text: r.utf8(3) };
    case 'ESID': return { type, reason: r.str(2), text: r.utf8(3) };
    case 'CD': return { type };
    case 'EERP': {
      const dsn = r.str(26);
      r.str(3);
      const date = r.str(8);
      const time = r.str(10);
      const user = r.str(8);
      const dest = r.str(25);
      const orig = r.str(25);
      const hash = Buffer.from(r.raw(r.u16()));
      const signature = r.rest().length >= 2 ? Buffer.from(r.raw(r.u16())) : Buffer.alloc(0);
      return { type, dsn, date, time, user, dest, orig, hash, signature };
    }
    case 'NERP': {
      const dsn = r.str(26);
      r.str(6);
      const date = r.str(8);
      const time = r.str(10);
      const dest = r.str(25);
      const orig = r.str(25);
      const creator = r.str(25);
      const reason = r.str(2);
      const text = r.utf8(3);
      const hash = r.rest().length >= 2 ? Buffer.from(r.raw(r.u16())) : Buffer.alloc(0);
      const signature = r.rest().length >= 2 ? Buffer.from(r.raw(r.u16())) : Buffer.alloc(0);
      return { type, dsn, date, time, dest, orig, creator, reason, text, hash, signature };
    }
    case 'RTR': return { type };
    case 'SECD': return { type };
    case 'AUCH': return { type, challenge: Buffer.from(r.raw(r.u16())) };
    case 'AURP': return { type, response: Buffer.from(r.raw(20)) };
  }
}

/** EERP/NERP signature content: the fields in their entirety, including padding (5.3.13). */
export function eerpSignedContent(e: { dsn: string; date: string; time: string; dest: string; orig: string; hash: Buffer }): Buffer {
  return Buffer.concat([str(e.dsn, 26), Buffer.from(e.date), Buffer.from(e.time), str(e.dest, 25), str(e.orig, 25), e.hash]);
}

// ---- Stream Transmission Buffer (section 8) -------------------------------------
export function frame(oeb: Buffer): Buffer {
  const len = oeb.length + 4;
  if (len > 100003) throw new CodecError('exchange buffer too large');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(len);
  h[0] = 0x10; // version 1, flags 0000
  return Buffer.concat([h, oeb]);
}

/** Incrementally extracts exchange buffers from a TCP stream. */
export class Deframer {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      if (this.buf[0] >> 4 !== 1) throw new CodecError(`bad stream header version ${this.buf[0] >> 4}`);
      const len = this.buf.readUInt32BE(0) & 0x00ffffff;
      if (len < 5 || len > 100003) throw new CodecError(`bad stream buffer length ${len}`);
      if (this.buf.length < len) break;
      out.push(this.buf.subarray(4, len));
      this.buf = this.buf.subarray(len);
    }
    return out;
  }
}

// ---- Data Exchange Buffer subrecords (section 7) ---------------------------------
/** Splits a virtual file (unstructured: one record) into DATA command payloads. */
export function toDataBuffers(file: Buffer, sdeb: number): Buffer[] {
  const max = sdeb - 1; // minus the command octet
  const out: Buffer[] = [];
  let cur: Buffer[] = [];
  let curLen = 0;
  let pos = 0;
  if (!file.length) return [Buffer.from([0x80])];
  while (pos < file.length) {
    if (curLen + 2 > max) {
      out.push(Buffer.concat(cur));
      cur = [];
      curLen = 0;
    }
    const n = Math.min(63, file.length - pos, max - curLen - 1);
    const last = pos + n === file.length;
    cur.push(Buffer.from([(last ? 0x80 : 0) | n]), file.subarray(pos, pos + n));
    curLen += 1 + n;
    pos += n;
  }
  out.push(Buffer.concat(cur));
  return out;
}

/** Reassembles subrecords (including buffer-compressed ones) from a DATA payload. */
export function fromDataBuffer(payload: Buffer): { data: Buffer; records: number } {
  const parts: Buffer[] = [];
  let records = 0;
  let i = 0;
  while (i < payload.length) {
    const h = payload[i++];
    const count = h & 0x3f;
    if (h & 0x40) {
      if (i >= payload.length) throw new CodecError('compressed subrecord truncated');
      parts.push(Buffer.alloc(count, payload[i++]));
    } else {
      if (i + count > payload.length) throw new CodecError('subrecord truncated');
      parts.push(payload.subarray(i, i + count));
      i += count;
    }
    if (h & 0x80) records++;
  }
  return { data: Buffer.concat(parts), records };
}

/** Virtual file dataset names: A-Z 0-9 and / - . & ( ), max 26. */
export function toDsn(filename: string): string {
  const s = filename.toUpperCase().replace(/[^A-Z0-9/\-.&()]/g, '-').replace(/^-+/, '').slice(0, 26);
  return s || 'FILE';
}

export function stamp(d = new Date()): { date: string; time: string } {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(Math.max(1, d.getUTCMilliseconds() * 10 + Math.floor(Math.random() * 10)), 4)}`,
  };
}

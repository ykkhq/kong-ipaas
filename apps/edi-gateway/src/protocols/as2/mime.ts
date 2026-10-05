// Byte-exact MIME helpers. Signatures cover the exact bytes of a MIME entity,
// so parts are sliced from the original buffer, never re-serialized.

const CRLF = Buffer.from('\r\n');

export type Headers = Record<string, string>;

/** Splits an entity into header block and body (accepts CRLF or bare LF). */
export function splitEntity(buf: Buffer): { headers: Headers; headerText: string; body: Buffer } {
  let idx = buf.indexOf('\r\n\r\n');
  let sep = 4;
  const lf = buf.indexOf('\n\n');
  if (idx === -1 || (lf !== -1 && lf < idx)) {
    idx = lf;
    sep = 2;
  }
  if (idx === -1) return { headers: {}, headerText: '', body: buf };
  const headerText = buf.subarray(0, idx).toString('latin1');
  return { headers: parseHeaders(headerText), headerText, body: buf.subarray(idx + sep) };
}

export function parseHeaders(text: string): Headers {
  const out: Headers = {};
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** "multipart/signed; boundary=\"x\"; micalg=sha-256" -> { value, params } */
export function parseParams(header = ''): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/** Raw parts of a multipart body (the CRLF before each delimiter belongs to the delimiter). */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let pos = body.indexOf(delim);
  if (pos === -1) throw new Error('multipart boundary not found');
  while (true) {
    let start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // closing delimiter
    // skip transport padding + line break after the delimiter
    while (body[start] === 0x20 || body[start] === 0x09) start++;
    if (body[start] === 0x0d) start++;
    if (body[start] === 0x0a) start++;
    const next = body.indexOf(delim, start);
    if (next === -1) throw new Error('multipart closing boundary not found');
    let end = next;
    if (body[end - 1] === 0x0a) end--;
    if (body[end - 1] === 0x0d) end--;
    parts.push(body.subarray(start, end));
    pos = next;
  }
  return parts;
}

export function decodeTransfer(headers: Headers, body: Buffer): Buffer {
  const cte = (headers['content-transfer-encoding'] ?? 'binary').toLowerCase();
  if (cte === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (cte === 'quoted-printable') {
    const s = body.toString('latin1').replace(/=\r?\n/g, '');
    return Buffer.from(s.replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return body;
}

export function buildEntity(headers: [string, string][], body: Buffer): Buffer {
  const head = headers.map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return Buffer.concat([Buffer.from(head, 'latin1'), CRLF, CRLF, body]);
}

export function buildMultipart(boundary: string, parts: Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) chunks.push(Buffer.from(`--${boundary}\r\n`), p, CRLF);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

export function boundary(): string {
  return `----=_Part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Canonicalizes line endings to CRLF (used for text MDN parts). */
export function crlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

export function filenameOf(headers: Headers): string | undefined {
  const cd = parseParams(headers['content-disposition']);
  return cd.params.filename || parseParams(headers['content-type']).params.name;
}

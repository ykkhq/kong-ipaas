import net from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { selfSigned, signOpaque, verifyOpaque } from '../src/protocols/as2/cms';
import { decode, Deframer, eerpSignedContent, encode, frame, fromDataBuffer, toDataBuffers, toDsn, type Cmd } from '../src/protocols/oftp2/codec';
import { CIPHER_SUITES, fileHash, securityLevel, unwrapFile, wrapFile, type Keys } from '../src/protocols/oftp2/files';
import { Channel, Session, type Hooks, type OutItem, type Peer } from '../src/protocols/oftp2/session';

describe('OFTP2 codec', () => {
  const samples: Cmd[] = [
    { type: 'SSRM' },
    { type: 'SSID', level: 5, code: 'O0013000000000000PARTNER', password: 'SECRET', sdeb: 4096, sr: 'B', compression: false, restart: false, special: false, credit: 64, auth: true, user: '' },
    { type: 'SFID', dsn: 'ORDERS.EDI', date: '20261005', time: '1200000001', user: '', dest: 'DEST', orig: 'ORIG', format: 'U', lrecl: 0, fileSize: 3, origSize: 2, restart: 0, security: '03', cipher: '04', compression: '1', envelope: '1', signedEerp: true, description: '注文 orders.edi' },
    { type: 'SFPA', count: 0 },
    { type: 'SFNA', reason: '20', retry: false, text: 'unsigned' },
    { type: 'EFID', records: 0, units: 12345 },
    { type: 'EFPA', cd: true },
    { type: 'EFNA', reason: '21', text: 'bad signature' },
    { type: 'ESID', reason: '00', text: '' },
    { type: 'CD' }, { type: 'RTR' }, { type: 'SECD' }, { type: 'CDT' },
    { type: 'EERP', dsn: 'ORDERS.EDI', date: '20261005', time: '1200000001', user: '', dest: 'ORIG', orig: 'DEST', hash: Buffer.from([1, 2, 3]), signature: Buffer.from([4, 5]) },
    { type: 'NERP', dsn: 'X', date: '20261005', time: '1200000001', dest: 'ORIG', orig: 'DEST', creator: 'DEST', reason: '31', text: 'sig', hash: Buffer.alloc(0), signature: Buffer.alloc(0) },
    { type: 'AUCH', challenge: Buffer.from('cms-blob') },
    { type: 'AURP', response: Buffer.alloc(20, 7) },
  ];
  it.each(samples.map((s) => [s.type, s]))('round-trips %s', (_t, c) => {
    expect(decode(encode(c as Cmd))).toEqual(c);
  });

  it('lays out SSID exactly as RFC 5024 5.3.2 (61 octets)', () => {
    const b = encode(samples[1]);
    expect(b.length).toBe(61);
    // 24-character ID is right-padded to 25
    expect(b.toString('latin1')).toBe('X5O0013000000000000PARTNER SECRET  04096BNNN064Y            \r');
  });

  it('frames and deframes across chunk boundaries', () => {
    const stream = Buffer.concat([frame(encode({ type: 'CD' })), frame(encode({ type: 'SFPA', count: 5 }))]);
    const d = new Deframer();
    const got = [...d.push(stream.subarray(0, 3)), ...d.push(stream.subarray(3, 9)), ...d.push(stream.subarray(9))].map(decode);
    expect(got).toEqual([{ type: 'CD' }, { type: 'SFPA', count: 5 }]);
    expect(stream[0]).toBe(0x10);
  });

  it.each([0, 1, 63, 64, 1000, 10000])('splits and joins a %i-octet file into data buffers', (n) => {
    const file = Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
    const bufs = toDataBuffers(file, 200);
    expect(bufs.every((b) => b.length <= 199)).toBe(true);
    expect(Buffer.concat(bufs.map((b) => fromDataBuffer(b).data))).toEqual(file);
  });

  it('expands buffer-compressed subrecords', () => {
    expect(fromDataBuffer(Buffer.from([0x40 | 5, 0x41, 0x80 | 2, 0x42, 0x43])).data.toString()).toBe('AAAAABC');
  });

  it('maps file names to dataset names', () => {
    expect(toDsn('invoice 2026_10.edi')).toBe('INVOICE-2026-10.EDI');
    expect(toDsn('注文.csv')).toBe('.CSV');
    expect(toDsn('a'.repeat(40)).length).toBe(26);
  });
});

describe('OFTP2 sessions over TCP', () => {
  let A: Keys;
  let B: Keys;
  beforeAll(async () => {
    [A, B] = await Promise.all([selfSigned('ALPHA'), selfSigned('BRAVO')]);
  });

  it('file services round-trip for every cipher suite', async () => {
    for (const suite of Object.keys(CIPHER_SUITES)) {
      const s = { sign: true, compress: true, encrypt: true, suite };
      const wrapped = await wrapFile(Buffer.from(`hello ${suite}`), s, A, B.certificate);
      expect(securityLevel(s)).toBe('03');
      const back = await unwrapFile(wrapped, { security: '03', compression: '1', envelope: '1', cipher: suite }, B, A.certificate);
      expect(back.toString()).toBe(`hello ${suite}`);
    }
  });

  /** In-memory station: files to send, received files, pending EERPs. */
  function station(id: string, keys: Keys) {
    const s = {
      id, keys,
      queue: [] as { id: string; name: string; data: Buffer; signedEerp: boolean }[],
      received: [] as { name: string; data: Buffer }[],
      pending: [] as Cmd[],
      sent: new Map<string, { hash: Buffer }>(),
      responses: [] as Cmd[],
      refuseUnsigned: false,
      hooks(_peerCert: string): Hooks {
        return {
          own: { odetteId: id, keys },
          log: () => undefined,
          lookup: async (code) => (code === s.peer.odetteId ? s.peer : null),
          outbound: async () => [
            ...s.pending.map((cmd, i): OutItem => ({ kind: 'eerp', id: `e${i}`, cmd: cmd as any })),
            ...s.queue.map((f): OutItem => ({
              kind: 'file', id: f.id, data: f.data,
              sfid: { dsn: toDsn(f.name), date: '20261005', time: `120000${f.id.padStart(4, '0')}`, user: '', dest: s.peer.odetteId, orig: id, format: 'U', lrecl: 0, fileSize: 1, origSize: 1, restart: 0, security: '00', cipher: '00', compression: '0', envelope: '0', signedEerp: f.signedEerp, description: f.name },
            })),
          ],
          eerpSent: async () => void (s.pending = []),
          fileSent: async (_p, item, r) => {
            s.queue = s.queue.filter((q) => q.id !== item.id);
            if (r.ok) s.sent.set(item.sfid.dsn, { hash: fileHash(item.data, '02') });
            else s.responses.push({ type: 'ESID', reason: r.reason!, text: r.text! });
          },
          acceptFile: (_p, sfid) => (s.refuseUnsigned && sfid.security === '00' ? { ok: false, reason: '20', text: 'unsigned' } : { ok: true }),
          fileReceived: async (_p, sfid, data) => {
            s.received.push({ name: sfid.description, data });
            const e: Extract<Cmd, { type: 'EERP' }> = { type: 'EERP', dsn: sfid.dsn, date: sfid.date, time: sfid.time, user: '', dest: sfid.orig, orig: sfid.dest, hash: Buffer.alloc(0), signature: Buffer.alloc(0) };
            if (sfid.signedEerp) {
              e.hash = fileHash(data, '02');
              e.signature = await signOpaque(eerpSignedContent(e), keys.certificate, keys.privateKey, 'sha1');
            }
            s.pending.push(e);
            return { ok: true };
          },
          responseReceived: async (_p, cmd) => void s.responses.push(cmd),
        };
      },
      peer: undefined as unknown as Peer,
    };
    return s;
  }

  async function run(a: ReturnType<typeof station>, b: ReturnType<typeof station>) {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const responder = new Promise<any>((resolve) => server.once('connection', (sock) => resolve(new Session(new Channel(sock, 5000), b.hooks(A.certificate)).runResponder())));
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const initiator = await new Session(new Channel(sock, 5000), a.hooks(B.certificate)).runInitiator(a.peer);
    const resp = await responder;
    server.close();
    return { initiator, responder: resp };
  }

  const pair = (auth: boolean, passwords = { aToB: 'PWA', bExpects: 'PWA' }) => {
    const a = station('ALPHA', A);
    const b = station('BRAVO', B);
    a.peer = { odetteId: 'BRAVO', sendPassword: passwords.aToB, receivePassword: 'PWB', secureAuth: auth, certificate: B.certificate, sdeb: 256, credit: 3 };
    b.peer = { odetteId: 'ALPHA', sendPassword: 'PWB', receivePassword: passwords.bExpects, secureAuth: auth, certificate: A.certificate, sdeb: 4096, credit: 64 };
    return { a, b };
  };

  it('sends a file and receives the EERP in the same session (small buffers, credit 3)', async () => {
    const { a, b } = pair(false);
    const big = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    a.queue.push({ id: '1', name: 'orders.edi', data: big, signedEerp: false });
    const r = await run(a, b);
    expect(r.initiator).toMatchObject({ ok: true, sent: 1, responses: 1 });
    expect(r.responder).toMatchObject({ ok: true, received: 1 });
    expect(b.received[0].data.equals(big)).toBe(true);
    expect(a.responses[0]).toMatchObject({ type: 'EERP', dsn: 'ORDERS.EDI', dest: 'ALPHA', orig: 'BRAVO' });
    expect(r.initiator.trace.join(' ')).toMatch(/-> SFID <- SFPA (-> DATA )+.*<- CDT.*-> EFID <- EFPA -> CD <- EERP -> RTR <- CD -> ESID/);
  });

  it('exchanges files both ways with secure authentication and a signed EERP', async () => {
    const { a, b } = pair(true);
    a.queue.push({ id: '1', name: 'a-to-b.edi', data: Buffer.from('from alpha'), signedEerp: true });
    b.queue.push({ id: '2', name: 'b-to-a.edi', data: Buffer.from('from bravo'), signedEerp: false });
    const r = await run(a, b);
    expect(r.initiator.ok).toBe(true);
    expect(r.initiator.trace.slice(0, 8).join(' ')).toBe('<- SSRM -> SSID <- SSID -> SECD <- AUCH -> AURP <- SECD -> AUCH');
    expect(b.received.map((f) => f.data.toString())).toEqual(['from alpha']);
    expect(a.received.map((f) => f.data.toString())).toEqual(['from bravo']);
    const eerp = a.responses.find((c) => c.type === 'EERP') as Extract<Cmd, { type: 'EERP' }>;
    expect(eerp.hash.equals(a.sent.get('A-TO-B.EDI')!.hash)).toBe(true);
    expect((await verifyOpaque(eerp.signature, B.certificate)).equals(eerpSignedContent(eerp))).toBe(true);
    // ALPHA acknowledges b-to-a in the same session: it gets the turn back after BRAVO's CD.
    expect(a.pending).toHaveLength(0);
    expect(b.responses.find((c) => c.type === 'EERP')).toMatchObject({ dsn: 'B-TO-A.EDI', dest: 'BRAVO', orig: 'ALPHA' });
    expect(r.initiator.trace.join(' ')).toMatch(/<- EERP -> RTR <- SFID -> SFPA <- DATA <- EFID -> EFPA <- CD -> EERP <- RTR -> CD <- ESID$/);
  });

  it('rejects a wrong password with ESID 04', async () => {
    const { a, b } = pair(false, { aToB: 'WRONG', bExpects: 'PWA' });
    const r = await run(a, b);
    expect(r.responder).toMatchObject({ ok: false, reason: '04' });
    expect(r.initiator).toMatchObject({ ok: false, reason: '04' });
  });

  it('fails secure authentication against the wrong certificate (ESID 11)', async () => {
    const { a, b } = pair(true);
    b.peer.certificate = B.certificate; // BRAVO encrypts ALPHA's challenge to the wrong key
    const r = await run(a, b);
    expect(r.initiator.ok).toBe(false);
    expect(['11', '12']).toContain(r.initiator.reason);
  });

  it('refuses an unsigned file with SFNA 20', async () => {
    const { a, b } = pair(false);
    b.refuseUnsigned = true;
    a.queue.push({ id: '1', name: 'plain.edi', data: Buffer.from('x'), signedEerp: false });
    const r = await run(a, b);
    expect(r.initiator.ok).toBe(true);
    expect(a.responses[0]).toMatchObject({ reason: '20' });
    expect(b.received).toHaveLength(0);
  });
});

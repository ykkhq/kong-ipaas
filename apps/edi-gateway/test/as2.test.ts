import { beforeAll, describe, expect, it, vi } from 'vitest';
import { compress, isCompressedData, uncompress } from '../src/protocols/as2/ber';
import { mic, selfSigned } from '../src/protocols/as2/cms';
import { buildEntity, buildMultipart, parseParams, splitEntity, splitMultipart } from '../src/protocols/as2/mime';
import { As2Adapter, parseMdnOptions } from '../src/protocols/as2/adapter';
import type { PartnerRow } from '../src/db';

describe('mime', () => {
  it('round-trips multipart parts byte-exactly', () => {
    const a = buildEntity([['Content-Type', 'text/plain']], Buffer.from('hello\r\n'));
    const b = buildEntity([['Content-Type', 'application/octet-stream']], Buffer.from([0, 1, 2, 13, 10, 255]));
    const body = buildMultipart('XyZ', [a, b]);
    expect(splitMultipart(body, 'XyZ')).toEqual([a, b]);
  });

  it('parses quoted params and folded headers', () => {
    const { headers } = splitEntity(Buffer.from('Content-Type: multipart/signed;\r\n\tboundary="a;b"; micalg=sha-256\r\n\r\nx'));
    expect(parseParams(headers['content-type'])).toEqual({ value: 'multipart/signed', params: { boundary: 'a;b', micalg: 'sha-256' } });
  });

  it('parses MDN options', () => {
    expect(parseMdnOptions('signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, sha-256, sha1'))
      .toEqual({ signed: true, micalg: 'sha-256' });
  });
});

describe('CMS compressed-data', () => {
  it('compresses and uncompresses', () => {
    const data = Buffer.from('ISA*00*'.repeat(500));
    const der = compress(data);
    expect(isCompressedData(der)).toBe(true);
    expect(uncompress(der)).toEqual(data);
    expect(der.length).toBeLessThan(data.length);
  });
});

// Two stations ("ALPHA" and "BETA") wired back to back: ALPHA's HTTP POST is
// delivered straight into BETA's inbound handler.
describe('AS2 loopback', () => {
  let alphaCert: { certificate: string; privateKey: string };
  let betaCert: { certificate: string; privateKey: string };
  const received: any[] = [];

  function station(as2Id: string, keys: { certificate: string; privateKey: string }, partners: PartnerRow[]) {
    const db = {
      getStation: async () => ({ as2Id }),
      partnersByProtocol: async () => partners,
      findMessage: async () => undefined,
    } as any;
    const vault = { get: async (k: string) => (k === 'station/as2' ? keys : null) } as any;
    const engine = { receive: async (_p: PartnerRow, doc: any) => { received.push({ as2Id, ...doc }); return {}; } } as any;
    return new As2Adapter({ db, vault, engine, log: () => undefined }, { port: 0, publicUrl: 'http://x/as2', timeoutMs: 5000 });
  }

  const partner = (as2Id: string, certificate: string, cfg: Record<string, any> = {}): PartnerRow => ({
    id: '00000000-0000-0000-0000-000000000001', name: as2Id, protocol: 'as2', enabled: true, inbound_flow: null,
    created_at: '', updated_at: '', config: { as2Id, url: 'http://beta/as2', certificate, sign: 'sha-256', encrypt: 'aes-256-cbc', mdn: 'sync', ...cfg },
  });

  let beta: As2Adapter;
  const wire = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
    const h = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const r = await beta.handleInbound(h, Buffer.from(init.body));
    return new Response(typeof r.body === 'string' ? r.body : new Uint8Array(r.body), { status: r.status, headers: r.headers });
  });

  beforeAll(async () => {
    [alphaCert, betaCert] = await Promise.all([selfSigned('ALPHA'), selfSigned('BETA')]);
  });

  it.each([
    ['signed + encrypted', {}],
    ['signed + encrypted + compressed', { compress: true }],
    ['signed only, sha1 MDN', { encrypt: '', sign: 'sha1' }],
    ['encrypted only', { sign: '' }],
    ['plain, unsigned MDN', { sign: '', encrypt: '', mdnSigned: false }],
  ])('%s delivers with a matching MIC', async (_n, cfg) => {
    beta = station('BETA', betaCert, [partner('ALPHA', alphaCert.certificate)]);
    const alpha = station('ALPHA', alphaCert, [partner('BETA', betaCert.certificate, cfg)]);
    const spy = wire();
    received.length = 0;
    const content = Buffer.from('UNA:+.? \'UNB+UNOC:3+ALPHA+BETA\'\r\nbinary:\x00\xff');
    const r = await alpha.send(partner('BETA', betaCert.certificate, cfg), { id: '11111111-1111-1111-1111-111111111111', filename: 'order.edi', contentType: 'application/edifact', content });
    spy.mockRestore();
    expect(r).toMatchObject({ ok: true, status: 'delivered' });
    if (r.ok) {
      expect(r.receipt!.mdn.status).toBe('processed');
      expect(r.receipt!.mdn.receivedMic).toBe(r.receipt!.mic);
      expect(r.receipt!.mdn.signed).toBe((cfg as Record<string, unknown>).mdnSigned !== false);
      if (r.receipt!.mdn.signed) expect(r.receipt!.mdn.verified).toBe(true);
    }
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ filename: 'order.edi', contentType: 'application/edifact' });
    expect(received[0].content.equals(content)).toBe(true);
  });

  it('reports authentication-failed when the signer is not the configured partner', async () => {
    const mallory = await selfSigned('MALLORY');
    beta = station('BETA', betaCert, [partner('ALPHA', mallory.certificate)]); // BETA expects a different cert
    const alpha = station('ALPHA', alphaCert, []);
    const spy = wire();
    received.length = 0;
    const r = await alpha.send(partner('BETA', betaCert.certificate), { id: '22222222-2222-2222-2222-222222222222', filename: 'x', contentType: 'text/plain', content: Buffer.from('x') });
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/processed\/error: authentication-failed/);
    expect(received).toHaveLength(0);
  });

  it('enforces requireEncrypted', async () => {
    beta = station('BETA', betaCert, [partner('ALPHA', alphaCert.certificate, { requireEncrypted: true })]);
    const alpha = station('ALPHA', alphaCert, []);
    const spy = wire();
    const r = await alpha.send(partner('BETA', betaCert.certificate, { encrypt: '' }), { id: '33333333-3333-3333-3333-333333333333', filename: 'x', contentType: 'text/plain', content: Buffer.from('x') });
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/insufficient-message-security/);
  });

  it('rejects unknown senders', async () => {
    beta = station('BETA', betaCert, []);
    const r = await beta.handleInbound({ 'as2-from': 'EVE', 'as2-to': 'BETA', 'content-type': 'text/plain' }, Buffer.from('x'));
    expect(r.status).toBe(403);
  });

  it('computes MIC over the content entity', () => {
    expect(mic(Buffer.from('abc'), 'sha-256')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { compress, decompress, unzipFirst, zipOne } from '../src/protocols/jx/compress';
import { JxAdapter } from '../src/protocols/jx/adapter';
import { JxFault, buildEnvelope, parseEnvelope } from '../src/protocols/jx/soap';
import type { PartnerRow } from '../src/db';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/jx/${n}.xml`, import.meta.url), 'utf8');

describe('JX SOAP (fixtures from jx_client / JISA guideline examples)', () => {
  it('parses GetDocumentResponse', () => {
    const r = parseEnvelope(fixture('get_document_response'));
    expect(r.body).toBe('GetDocumentResponse');
    expect(r.header).toMatchObject({ From: 'svruri.co.jp', To: 'cliuri.co.jp', Timestamp: '2004-03-13T12:38:19' });
    expect(r.values.GetDocumentResult).toBe('true');
    expect(Buffer.from(r.values.data, 'base64').toString()).toBe('data');
  });

  it.each([['put_document_response', 'PutDocumentResult'], ['confirm_document_response', 'ConfirmDocumentResult']])('parses %s', (f, field) => {
    const r = parseEnvelope(fixture(f));
    expect(['true', 'false']).toContain(r.values[field]);
  });

  it('turns a SOAP Fault into JxFault', () => {
    expect(() => parseEnvelope(fixture('soap_fault'))).toThrow(JxFault);
  });

  it('accepts header fields without the MessageHeader wrapper and the hyphenless namespace (jx_client/Savon)', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ins0="http://www.dsri.jp/edi-bp/2004/jedicosxml/client-server">
      <soap:Header><From>S</From><To>H</To><MessageId>m@s</MessageId><Timestamp>2026-10-05T15:25:15Z</Timestamp></soap:Header>
      <soap:Body><ins0:PutDocument><ins0:messageId>m@s</ins0:messageId><ins0:data>eA==</ins0:data><ins0:senderId>S</ins0:senderId><ins0:receiverId>H</ins0:receiverId>
      <ins0:formatType>F</ins0:formatType><ins0:documentType>D</ins0:documentType><ins0:compressType/></ins0:PutDocument></soap:Body></soap:Envelope>`;
    const r = parseEnvelope(xml);
    expect(r.header).toMatchObject({ From: 'S', To: 'H', MessageId: 'm@s' });
    expect(r.values).toMatchObject({ messageId: 'm@s', data: 'eA==', compressType: '' });
  });

  it('builds WSDL-ordered, namespace-qualified elements', () => {
    const xml = buildEnvelope({ From: 'a', To: 'b', MessageId: 'm@x', Timestamp: '2026-10-06T00:00:00', OptionalFormatType: 'F', OptionalDocumentType: 'D' }, 'GetDocument', { receiverId: 'R&D' });
    expect(xml).toContain('<MessageHeader xmlns="http://www.dsri.jp/edi-bp/2004/jedicos-xml/client-server"><From>a</From><To>b</To><MessageId>m@x</MessageId><Timestamp>2026-10-06T00:00:00</Timestamp><OptionalFormatType>F</OptionalFormatType><OptionalDocumentType>D</OptionalDocumentType></MessageHeader>');
    expect(xml).toContain('<GetDocument xmlns="http://www.dsri.jp/edi-bp/2004/jedicos-xml/client-server"><receiverId>R&amp;D</receiverId></GetDocument>');
    expect(parseEnvelope(xml).values.receiverId).toBe('R&D');
  });
});

describe('JX compression', () => {
  const doc = Buffer.from('発注,1,2,3\n'.repeat(200));
  it('round-trips ZIP with a UTF-8 entry name', () => {
    expect(unzipFirst(zipOne('発注.csv', doc))).toEqual({ data: doc, name: '発注.csv' });
  });
  it('round-trips gzip and passes through uncompressed', () => {
    expect(decompress('application/gzip', compress('application/gzip', doc)).data).toEqual(doc);
    expect(decompress('', compress('', doc)).data).toEqual(doc);
  });
});

describe('JX client <-> server loopback', () => {
  const store = new Map<string, Buffer>();
  const rows = new Map<string, any>();
  const received: any[] = [];
  const serverPartner: PartnerRow = {
    id: '00000000-0000-0000-0000-00000000000a', name: 'store', protocol: 'jx', enabled: true, inbound_flow: null, created_at: '', updated_at: '',
    config: { mode: 'server', jxId: 'STORE', formatType: 'SecondGenEDI', documentType: 'Order', compressType: 'application/zip', username: 'store' },
  };
  const clientPartner: PartnerRow = {
    ...serverPartner, id: '00000000-0000-0000-0000-00000000000b', name: 'hub',
    config: { mode: 'client', jxId: 'HUB', url: 'http://hub/jx', formatType: 'SecondGenEDI', documentType: 'Order', compressType: 'application/zip', username: 'store' },
  };

  const hub = new JxAdapter({
    db: {
      getStation: async () => ({ jxId: 'HUB' }),
      partnersByProtocol: async () => [serverPartner],
      findMessage: async (_p: string, id: string, dir: string) => [...rows.values()].find((r) => r.message_id === id && r.direction === dir),
      findByMessageId: async (_p: string, id: string) => [...rows.values()].find((r) => r.message_id === id && r.direction === 'out'),
      updateMessage: async (id: string, patch: any) => Object.assign(rows.get(id), patch),
      pool: { query: async () => ({ rows: [...rows.values()].filter((r) => r.direction === 'out' && ['queued', 'awaiting-receipt'].includes(r.status)) }) },
    } as any,
    vault: { get: async () => ({ password: 's3cret' }) } as any,
    engine: { receive: async (_p: any, d: any) => { received.push(d); rows.set(`in-${rows.size}`, { direction: 'in', message_id: d.messageId }); } } as any,
    log: () => undefined,
  }, { get: async (id: string) => store.get(id)! } as any, { port: 0, timeoutMs: 5000 });

  const client = new JxAdapter({
    db: { getStation: async () => ({ jxId: 'STORE' }), findMessage: async () => undefined } as any,
    vault: { get: async () => ({ password: 's3cret' }) } as any,
    engine: { receive: async (_p: any, d: any) => void received.push({ client: true, ...d }) } as any,
    log: () => undefined,
  }, {} as any, { port: 0, timeoutMs: 5000 });

  const wire = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
    const r = await hub.handleRequest(init.headers.Authorization, init.body);
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'text/xml' } });
  });

  it('PutDocument delivers once, duplicates return false', async () => {
    const spy = wire();
    const doc = { id: '11111111-1111-1111-1111-111111111111', filename: 'order.csv', contentType: 'text/csv', content: Buffer.from('order,1\n') };
    const r = await client.send(clientPartner, doc);
    expect(r).toMatchObject({ ok: true, status: 'delivered', receipt: { duplicate: false } });
    expect(received[0]).toMatchObject({ filename: 'order.csv', receipt: { senderId: 'STORE', formatType: 'SecondGenEDI', compressType: 'application/zip' } });
    expect(received[0].content.toString()).toBe('order,1\n');
    const again = await client.send(clientPartner, doc);
    expect(again).toMatchObject({ ok: true, receipt: { duplicate: true } });
    expect(received).toHaveLength(1);
    spy.mockRestore();
  });

  it('GetDocument serves the oldest queued document until ConfirmDocument', async () => {
    rows.set('o1', { id: 'o1', direction: 'out', message_id: 'o1@hub', status: 'queued', filename: 'asn.csv', receipt: { formatType: 'SecondGenEDI', documentType: 'Shipment', compressType: 'application/gzip' } });
    store.set('o1', Buffer.from('asn,9\n'));
    received.length = 0;
    const spy = wire();
    const r = await client.poll(clientPartner);
    spy.mockRestore();
    expect(r).toEqual({ received: 1, duplicates: 0 });
    expect(received[0]).toMatchObject({ client: true, messageId: 'o1@hub', receipt: { documentType: 'Shipment' } });
    expect(received[0].content.toString()).toBe('asn,9\n');
    expect(rows.get('o1')).toMatchObject({ status: 'delivered' });
  });

  it('rejects bad credentials, one-sided type filters and unknown confirmations', async () => {
    const env = (body: any, values: any, extra = {}) => buildEnvelope({ From: 'STORE', To: 'HUB', MessageId: 'x@y', Timestamp: 't', ...extra }, body, values);
    const auth = `Basic ${Buffer.from('store:s3cret').toString('base64')}`;
    expect((await hub.handleRequest(`Basic ${Buffer.from('store:nope').toString('base64')}`, env('GetDocument', { receiverId: 'STORE' }))).status).toBe(401);
    const oneSided = await hub.handleRequest(auth, env('GetDocument', { receiverId: 'STORE' }, { OptionalFormatType: 'SecondGenEDI' }));
    expect(oneSided.status).toBe(500);
    expect(() => parseEnvelope(oneSided.body)).toThrow(/must be given together/);
    const unknown = await hub.handleRequest(auth, env('ConfirmDocument', { messageId: 'nope@x', senderId: 'HUB', receiverId: 'STORE' }));
    expect(() => parseEnvelope(unknown.body)).toThrow(/unknown messageId/);
  });
});

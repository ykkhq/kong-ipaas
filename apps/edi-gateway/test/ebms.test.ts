import { describe, expect, it, vi } from 'vitest';
import { EbmsAdapter, parseMessage } from '../src/protocols/ebms/adapter';
import { buildEnvelope, parseEnvelope } from '../src/protocols/ebms/soap';
import type { PartnerRow } from '../src/db';

describe('ebMS envelopes', () => {
  it('round-trips a message header with AckRequested, SyncReply and Manifest', () => {
    const xml = buildEnvelope({
      header: { from: { id: 'SELLER', type: 'urn:jp:gln', role: 'Seller' }, to: { id: 'BUYER' }, cpaId: 'cpa-1', conversationId: 'c1', service: 'urn:services:order', serviceType: 'string', action: 'Order', messageId: 'm1@x', timestamp: '2026-10-05T00:00:00Z', duplicateElimination: true },
      ackRequested: { signed: false }, syncReply: true, manifest: [{ href: 'cid:p1' }],
    });
    const e = parseEnvelope(xml);
    expect(e.header).toMatchObject({ from: { id: 'SELLER', type: 'urn:jp:gln', role: 'Seller' }, to: { id: 'BUYER' }, cpaId: 'cpa-1', action: 'Order', serviceType: 'string', duplicateElimination: true });
    expect(e).toMatchObject({ ackRequested: { signed: false }, syncReply: true, manifest: [{ href: 'cid:p1' }] });
  });

  it('parses foreign prefixes and ErrorLists', () => {
    const xml = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="http://www.oasis-open.org/committees/ebxml-msg/schema/msg-header-2_0.xsd"><soapenv:Header>
      <ns:MessageHeader soapenv:mustUnderstand="1" ns:version="2.0"><ns:From><ns:PartyId>A</ns:PartyId></ns:From><ns:To><ns:PartyId>B</ns:PartyId></ns:To>
      <ns:CPAId>cpa</ns:CPAId><ns:ConversationId>c</ns:ConversationId><ns:Service>urn:oasis:names:tc:ebxml-msg:service</ns:Service><ns:Action>MessageError</ns:Action>
      <ns:MessageData><ns:MessageId>e1</ns:MessageId><ns:Timestamp>2026-10-05T00:00:00Z</ns:Timestamp><ns:RefToMessageId>m1</ns:RefToMessageId></ns:MessageData></ns:MessageHeader>
      <ns:ErrorList ns:highestSeverity="Error" ns:version="2.0"><ns:Error ns:errorCode="Inconsistent" ns:severity="Error" ns:location="cid:x"><ns:Description>bad</ns:Description></ns:Error></ns:ErrorList>
      </soapenv:Header><soapenv:Body/></soapenv:Envelope>`;
    expect(parseEnvelope(xml)).toMatchObject({ header: { refToMessageId: 'm1' }, errors: [{ code: 'Inconsistent', location: 'cid:x', description: 'bad' }] });
  });
});

describe('ebMS loopback', () => {
  const received: any[] = [];
  const messages = new Map<string, any>();
  function station(partyId: string, partners: PartnerRow[]) {
    const db = {
      getStation: async () => ({ partyId }),
      partnersByProtocol: async () => partners,
      findMessage: async (_p: string, id: string, dir: string) => [...messages.values()].find((m) => m.message_id === id && m.direction === dir),
      updateMessage: async (id: string, patch: any) => Object.assign(messages.get(id), patch),
    } as any;
    const engine = {
      receive: async (p: PartnerRow, doc: any) => {
        received.push({ partyId, ...doc });
        const id = `in-${messages.size}`;
        messages.set(id, { id, direction: 'in', message_id: doc.messageId });
        return {};
      },
    } as any;
    return new EbmsAdapter({ db, vault: { get: async () => null } as any, engine, log: () => undefined }, {} as any, { port: 0, timeoutMs: 5000 });
  }
  const partner = (partyId: string, cfg: Record<string, any> = {}): PartnerRow => ({
    id: '00000000-0000-0000-0000-000000000002', name: partyId, protocol: 'ebms', enabled: true, inbound_flow: null, created_at: '', updated_at: '',
    config: { partyId, url: `http://${partyId}/ebms`, cpaId: 'cpa-1', service: 'urn:svc', action: 'Send', ...cfg },
  });

  const wire = (targets: Record<string, EbmsAdapter>) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const host = new URL(String(url)).hostname;
    const r = await targets[host.toUpperCase()].handleInbound(init.headers['Content-Type'], Buffer.from(init.body));
    return new Response(r.body ? (typeof r.body === 'string' ? r.body : new Uint8Array(r.body)) : null, { status: r.status, headers: r.contentType ? { 'content-type': r.contentType } : {} });
  });

  it('delivers with a synchronous Acknowledgment and eliminates duplicates', async () => {
    received.length = 0;
    const b = station('BUYER', [partner('SELLER')]);
    const a = station('SELLER', []);
    const spy = wire({ BUYER: b });
    const doc = { id: '11111111-1111-1111-1111-111111111111', filename: 'order.xml', contentType: 'application/xml', content: Buffer.from('<Order>1</Order>') };
    const r = await a.send(partner('BUYER'), doc);
    expect(r).toMatchObject({ ok: true, status: 'delivered', receipt: { acknowledgment: { from: 'BUYER' } } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ filename: 'order.xml', contentType: 'application/xml' });
    expect(received[0].content.toString()).toBe('<Order>1</Order>');
    // Same MessageId again (a retry): acknowledged, not delivered twice.
    const again = await (a as any).transmit(partner('BUYER'), { partyId: 'SELLER' }, doc, { ...r.receipt });
    expect(again).toMatchObject({ ok: true, status: 'delivered' });
    expect(received).toHaveLength(1);
    spy.mockRestore();
  });

  it('returns an ebMS error for an unknown sender', async () => {
    const b = station('BUYER', []);
    const a = station('SELLER', []);
    const spy = wire({ BUYER: b });
    const r = await a.send(partner('BUYER'), { id: '22222222-2222-2222-2222-222222222222', filename: 'x', contentType: 'text/plain', content: Buffer.from('x') });
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ValueNotRecognized at MessageHeader\/From\/PartyId/);
  });

  it('completes an asynchronous Acknowledgment', async () => {
    received.length = 0;
    const b = station('BUYER', [partner('SELLER', { syncReply: false })]);
    const a = station('SELLER', [partner('BUYER', { syncReply: false })]);
    const spy = wire({ BUYER: b, SELLER: a });
    const r = await a.send(partner('BUYER', { syncReply: false }), { id: '33333333-3333-3333-3333-333333333333', filename: 'x', contentType: 'text/plain', content: Buffer.from('x') });
    expect(r).toMatchObject({ ok: true, status: 'awaiting-receipt' });
    messages.set('out-1', { id: 'out-1', direction: 'out', message_id: r.ok ? r.messageId : '', status: 'awaiting-receipt', receipt: {} });
    await new Promise((res) => setTimeout(res, 50));
    spy.mockRestore();
    expect(messages.get('out-1')).toMatchObject({ status: 'delivered', receipt: { acknowledgment: { from: 'BUYER' } } });
  });

  it('answers StatusRequest with the receipt status', async () => {
    const b = station('BUYER', [partner('SELLER')]);
    messages.set('in-x', { id: 'in-x', direction: 'in', message_id: 'known@x', partner_id: partner('SELLER').id, status: 'received', created_at: '2026-10-05T00:00:00Z' });
    const req = (ref: string) => buildEnvelope({ header: { from: { id: 'SELLER' }, to: { id: 'BUYER' }, cpaId: 'cpa-1', conversationId: 'c', service: 'urn:oasis:names:tc:ebxml-msg:service', action: 'StatusRequest', messageId: 's1', timestamp: 'now' }, statusRequest: { refToMessageId: ref } });
    const known = await b.handleInbound('text/xml', Buffer.from(req('known@x')));
    expect(parseEnvelope(known.body as string)).toMatchObject({ header: { action: 'StatusResponse' }, statusResponse: { refToMessageId: 'known@x', status: 'Received', timestamp: '2026-10-05T00:00:00Z' } });
    const unknown = await b.handleInbound('text/xml', Buffer.from(req('nope@x')));
    expect(parseEnvelope(unknown.body as string).statusResponse).toMatchObject({ status: 'NotRecognized' });
  });

  it('answers Ping with Pong', async () => {
    const b = station('BUYER', [partner('SELLER')]);
    const ping = buildEnvelope({ header: { from: { id: 'SELLER' }, to: { id: 'BUYER' }, cpaId: 'cpa-1', conversationId: 'c', service: 'urn:oasis:names:tc:ebxml-msg:service', action: 'Ping', messageId: 'p1', timestamp: 'now' } });
    const r = await b.handleInbound('text/xml', Buffer.from(ping));
    expect(parseMessage(r.contentType!, Buffer.from(r.body as string)).env.header).toMatchObject({ action: 'Pong', refToMessageId: 'p1', from: { id: 'BUYER' } });
  });
});

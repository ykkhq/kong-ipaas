import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MessageRow, PartnerRow } from '../../db';
import type { AdapterContext, OutboundDoc, ProtocolAdapter, SendResult } from '../../engine';
import type { PayloadStore } from '../../store';
import { GZIP, ZIP, compress, decompress } from './compress';
import { JxFault, buildEnvelope, buildFault, parseEnvelope, soapAction, timestamp, type MessageHeader, type Operation } from './soap';

/*
 * Station:  edi_station.jx = { jxId, domain? }           (our senderId/receiverId and MessageHeader From)
 * Partner:  jxId (their sender/receiver id), mode 'server' (partner calls our /jx) | 'client' (we call their server),
 *           formatType, documentType, compressType ('' | application/zip | application/gzip),
 *           client: url, username?, pollIntervalSec?, getFormatType?/getDocumentType? (2007 filter)
 *           server: username? (Basic login the partner uses), acceptedTypes? ("format/document", …)
 * Vault:    edi/partners/<id> = { password? }  (client: our Basic password; server: password the partner must send)
 */

interface Station { jxId: string; domain: string }

export class JxAdapter implements ProtocolAdapter {
  readonly protocol = 'jx' as const;
  private http?: FastifyInstance;
  private pollTimer?: NodeJS.Timeout;
  private lastPoll = new Map<string, number>();
  private polling = new Set<string>();

  constructor(private ctx: AdapterContext, private store: PayloadStore, private opts: { port: number; timeoutMs: number }) {}

  validate(c: Record<string, any>): string[] {
    const errs: string[] = [];
    if (!c.jxId) errs.push('jxId (partner sender/receiver id) is required');
    if (!['server', 'client'].includes(c.mode ?? 'server')) errs.push('mode must be server or client');
    if ((c.mode ?? 'server') === 'client' && !/^https?:\/\//.test(c.url ?? '')) errs.push('url is required in client mode');
    if (!c.formatType || !c.documentType) errs.push('formatType and documentType are required (agreed with the partner)');
    if (c.compressType && ![ZIP, GZIP].includes(c.compressType)) errs.push('compressType must be empty, application/zip or application/gzip');
    if (Boolean(c.getFormatType) !== Boolean(c.getDocumentType)) errs.push('getFormatType and getDocumentType must be set together');
    return errs;
  }

  async station(): Promise<Station> {
    const s = await this.ctx.db.getStation('jx');
    if (!s.jxId) throw new Error('JX station is not configured (set our JX id)');
    return { jxId: s.jxId, domain: s.domain || 'ipaas.local' };
  }

  private header(st: Station, to: string, extra: Partial<MessageHeader> = {}): MessageHeader {
    return { From: st.jxId, To: to, MessageId: `${randomUUID()}@${st.domain}`, Timestamp: timestamp(), ...extra };
  }

  // ---- outbound ------------------------------------------------------------------
  async send(partner: PartnerRow, doc: OutboundDoc): Promise<SendResult> {
    const st = await this.station();
    const c = partner.config;
    const messageId = `${doc.id}@${st.domain}`;
    const receipt = { formatType: c.formatType, documentType: c.documentType, compressType: c.compressType || '', mode: c.mode ?? 'server' };
    if ((c.mode ?? 'server') === 'server') {
      // The partner (a JX client) fetches it with GetDocument and acknowledges with ConfirmDocument.
      return { ok: true, status: 'queued', messageId, receipt: { ...receipt, note: 'waiting for the partner to GetDocument' } };
    }
    const data = compress(c.compressType || '', doc.content, doc.filename).toString('base64');
    const values = { messageId, data, senderId: st.jxId, receiverId: c.jxId, formatType: c.formatType, documentType: c.documentType, compressType: c.compressType || '' };
    let last = '';
    // The guideline: on a SOAP Fault or no response, resend PutDocument with the same messageId.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await this.call(partner, 'PutDocument', this.header(st, c.jxId), values);
        const accepted = r.values.PutDocumentResult === 'true';
        return { ok: true, status: 'delivered', messageId, receipt: { ...receipt, attempts: attempt, duplicate: !accepted } };
      } catch (e) {
        last = (e as Error).message;
        if (e instanceof JxFault && e.code === 'Client') break; // our request is wrong: retrying won't help
        if (attempt < 3) await new Promise((res) => setTimeout(res, 1000 * attempt));
      }
    }
    return { ok: false, messageId, receipt, error: `JX PutDocument to ${c.url}: ${last}` };
  }

  private async call(partner: PartnerRow, op: Operation, header: MessageHeader, values: Record<string, unknown>) {
    const c = partner.config;
    const headers: Record<string, string> = { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${soapAction(op)}"` };
    if (c.username) {
      const sec = await this.ctx.vault.get<{ password?: string }>(`partners/${partner.id}`);
      headers.Authorization = `Basic ${Buffer.from(`${c.username}:${sec?.password ?? ''}`).toString('base64')}`;
    }
    const res = await fetch(c.url, { method: 'POST', headers, body: buildEnvelope(header, op, values), signal: AbortSignal.timeout(this.opts.timeoutMs) });
    const text = await res.text();
    if (!/Envelope/.test(text)) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const parsed = parseEnvelope(text); // throws JxFault on SOAP Fault
    if (parsed.body !== `${op}Response`) throw new Error(`unexpected response ${parsed.body}`);
    return parsed;
  }

  /** Client mode: GetDocument until none left; ConfirmDocument each after it is stored. */
  async poll(partner: PartnerRow, max = 100): Promise<{ received: number; duplicates: number }> {
    const st = await this.station();
    const c = partner.config;
    let received = 0;
    let duplicates = 0;
    for (let i = 0; i < max; i++) {
      const filter = c.getFormatType ? { OptionalFormatType: c.getFormatType, OptionalDocumentType: c.getDocumentType } : {};
      const r = await this.call(partner, 'GetDocument', this.header(st, c.jxId, filter), { receiverId: st.jxId });
      if (r.values.GetDocumentResult !== 'true') break;
      const v = r.values;
      if (await this.ctx.db.findMessage('jx', v.messageId, 'in')) duplicates++;
      else {
        await this.deliver(partner, v);
        received++;
      }
      // Confirm even for a duplicate: the server must stop re-sending it.
      await this.call(partner, 'ConfirmDocument', this.header(st, c.jxId), { messageId: v.messageId, senderId: v.senderId, receiverId: v.receiverId });
    }
    return { received, duplicates };
  }

  private async deliver(partner: PartnerRow, v: Record<string, string>): Promise<void> {
    const raw = Buffer.from(v.data, 'base64');
    let content: Buffer = raw;
    let name: string | undefined;
    if (v.compressType && partner.config.decompress !== false) ({ data: content, name } = decompress(v.compressType, raw));
    await this.ctx.engine.receive(partner, {
      messageId: v.messageId,
      filename: name ?? `${v.formatType}-${v.documentType}-${v.messageId.split('@')[0]}.dat`,
      contentType: 'application/octet-stream',
      content,
      receipt: { senderId: v.senderId, receiverId: v.receiverId, formatType: v.formatType, documentType: v.documentType, compressType: v.compressType, compressedSize: v.compressType ? raw.length : undefined },
    });
  }

  private async pollDue(): Promise<void> {
    for (const p of await this.ctx.db.partnersByProtocol('jx')) {
      const every = Number(p.config.pollIntervalSec) * 1000;
      if (p.config.mode !== 'client' || !every || this.polling.has(p.id)) continue;
      if (Date.now() - (this.lastPoll.get(p.id) ?? 0) < every) continue;
      this.lastPoll.set(p.id, Date.now());
      this.polling.add(p.id);
      this.poll(p).catch((e) => this.ctx.log(`jx poll ${p.name}: ${e.message}`)).finally(() => this.polling.delete(p.id));
    }
  }

  // ---- server (our JX hub) -------------------------------------------------------
  async start(): Promise<void> {
    this.http = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
    this.http.removeAllContentTypeParsers();
    this.http.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    const handler = async (req: any, reply: any) => {
      const r = await this.handleRequest(req.headers.authorization, String(req.body ?? ''));
      reply.code(r.status).header('Content-Type', 'text/xml; charset=utf-8');
      if (r.status === 401) reply.header('WWW-Authenticate', 'Basic realm="JX"');
      return reply.send(r.body);
    };
    this.http.post('/jx', handler);
    this.http.post('/', handler);
    this.http.get('/jx', async () => 'JX手順 server: POST PutDocument / GetDocument / ConfirmDocument here.');
    await this.http.listen({ host: '0.0.0.0', port: this.opts.port });
    this.pollTimer = setInterval(() => void this.pollDue(), 10000);
    this.ctx.log(`jx server on :${this.opts.port}/jx`);
  }

  async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    await this.http?.close();
  }

  async handleRequest(authorization: string | undefined, xml: string): Promise<{ status: number; body: string }> {
    let st: Station;
    try {
      st = await this.station();
    } catch (e) {
      return { status: 500, body: buildFault('Server', (e as Error).message) };
    }
    try {
      const req = parseEnvelope(xml);
      if (!req.header) throw new JxFault('Client', 'MessageHeader is missing');
      const partner = await this.authenticate(authorization, req.header.From);
      if (!partner) return { status: 401, body: buildFault('Client', 'authentication failed') };
      const v = req.values;
      const reply = (body: 'PutDocumentResponse' | 'GetDocumentResponse' | 'ConfirmDocumentResponse', values: Record<string, unknown>) =>
        ({ status: 200, body: buildEnvelope(this.header(st, req.header!.From), body, values) });

      switch (req.body) {
        case 'PutDocument': {
          if (v.senderId !== partner.config.jxId) throw new JxFault('Client', `senderId ${v.senderId} does not match the authenticated partner`);
          if (v.receiverId !== st.jxId) throw new JxFault('Client', `unknown receiverId ${v.receiverId}`);
          if (!v.messageId) throw new JxFault('Client', 'messageId is empty');
          const accepted = partner.config.acceptedTypes as string[] | undefined;
          if (accepted?.length && !accepted.includes(`${v.formatType}/${v.documentType}`)) {
            throw new JxFault('Client', `formatType/documentType ${v.formatType}/${v.documentType} is not registered`);
          }
          if (await this.ctx.db.findMessage('jx', v.messageId, 'in')) return reply('PutDocumentResponse', { PutDocumentResult: false });
          try {
            await this.deliver(partner, v);
          } catch (e) {
            throw new JxFault('Client', `cannot read document: ${(e as Error).message}`);
          }
          return reply('PutDocumentResponse', { PutDocumentResult: true });
        }
        case 'GetDocument': {
          if (v.receiverId !== partner.config.jxId) throw new JxFault('Client', `receiverId ${v.receiverId} does not match the authenticated partner`);
          const h = req.header;
          if ((h.OptionalFormatType === undefined) !== (h.OptionalDocumentType === undefined)) {
            throw new JxFault('Client', 'OptionalFormatType and OptionalDocumentType must be given together');
          }
          const m = await this.nextFor(partner, h.OptionalFormatType, h.OptionalDocumentType);
          if (!m) {
            return reply('GetDocumentResponse', { GetDocumentResult: false, messageId: '', data: '', senderId: '', receiverId: '', formatType: '', documentType: '', compressType: '' });
          }
          const r = (m.receipt ?? {}) as Record<string, any>;
          const data = compress(r.compressType || '', await this.store.get(m.id), m.filename ?? 'document.dat');
          await this.ctx.db.updateMessage(m.id, { status: 'awaiting-receipt', receipt: { ...r, fetchedAt: new Date().toISOString(), fetches: (r.fetches ?? 0) + 1 } });
          return reply('GetDocumentResponse', {
            GetDocumentResult: true, messageId: m.message_id, data: data.toString('base64'), senderId: st.jxId, receiverId: partner.config.jxId,
            formatType: r.formatType, documentType: r.documentType, compressType: r.compressType || '',
          });
        }
        case 'ConfirmDocument': {
          const m = await this.ctx.db.findByMessageId(partner.id, v.messageId);
          if (!m || v.receiverId !== partner.config.jxId) throw new JxFault('Client', `unknown messageId ${v.messageId}`);
          if (m.status === 'delivered') return reply('ConfirmDocumentResponse', { ConfirmDocumentResult: false });
          await this.ctx.db.updateMessage(m.id, { status: 'delivered', receipt: { ...(m.receipt ?? {}), confirmedAt: new Date().toISOString() }, error: null });
          return reply('ConfirmDocumentResponse', { ConfirmDocumentResult: true });
        }
        default:
          throw new JxFault('Client', `${req.body} is not a request`);
      }
    } catch (e) {
      if (e instanceof JxFault) return { status: 500, body: buildFault(e.code, e.message) };
      this.ctx.log(`jx server error: ${(e as Error).message}`);
      return { status: 500, body: buildFault('Server', 'internal error') };
    }
  }

  /** Basic auth (username + Vault password) or, for partners without a password, the MessageHeader From. */
  private async authenticate(authorization: string | undefined, from: string): Promise<PartnerRow | null> {
    const partners = (await this.ctx.db.partnersByProtocol('jx')).filter((p) => (p.config.mode ?? 'server') === 'server');
    const m = /^Basic\s+(.+)$/i.exec(authorization ?? '');
    if (m) {
      const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      const pass = rest.join(':');
      const p = partners.find((x) => x.config.username === user);
      if (!p) return null;
      const sec = await this.ctx.vault.get<{ password?: string }>(`partners/${p.id}`);
      return sec?.password && safeEqual(sec.password, pass) ? p : null;
    }
    const p = partners.find((x) => x.config.jxId === from && !x.config.username);
    return p ?? null;
  }

  /** Oldest unconfirmed document for the partner, optionally limited to a format/document type. */
  private async nextFor(partner: PartnerRow, formatType?: string, documentType?: string): Promise<MessageRow | undefined> {
    const rows = await this.ctx.db.pool.query<MessageRow>(
      `SELECT * FROM edi_messages WHERE partner_id = $1 AND direction = 'out' AND protocol = 'jx' AND status IN ('queued', 'awaiting-receipt')
       AND ($2::text IS NULL OR receipt->>'formatType' = $2) AND ($3::text IS NULL OR receipt->>'documentType' = $3)
       ORDER BY created_at LIMIT 1`, [partner.id, formatType ?? null, documentType ?? null]);
    return rows.rows[0];
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

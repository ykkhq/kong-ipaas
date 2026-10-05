import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PartnerRow } from '../../db';
import type { AdapterContext, OutboundDoc, ProtocolAdapter, SendResult } from '../../engine';
import type { PayloadStore } from '../../store';
import { buildEntity, buildMultipart, decodeTransfer, parseParams, splitEntity, splitMultipart } from '../as2/mime';
import { EBMS_SERVICE, EnvelopeError, buildEnvelope, parseEnvelope, timestamp, type EbmsError, type Envelope, type Header } from './soap';

/*
 * Station:  edi_station.ebms = { partyId, partyIdType?, publicUrl? }
 * Partner:  partyId, partyIdType?, url, cpaId, service, serviceType?, action, fromRole?, toRole?,
 *           ackRequested (default true), syncReply (default true), duplicateElimination (default true),
 *           retries (default 3), retryIntervalSec (default 60), username?
 * Vault:    edi/partners/<id> = { password? }   (HTTP basic auth towards the partner)
 */

interface Station { partyId: string; partyIdType?: string }

export class EbmsAdapter implements ProtocolAdapter {
  readonly protocol = 'ebms' as const;
  private http?: FastifyInstance;
  private retryTimer?: NodeJS.Timeout;

  constructor(private ctx: AdapterContext, private store: PayloadStore, private opts: { port: number; timeoutMs: number }) {}

  validate(c: Record<string, any>): string[] {
    const errs: string[] = [];
    for (const k of ['partyId', 'cpaId', 'service', 'action']) if (!c[k]) errs.push(`${k} is required`);
    if (!/^https?:\/\//.test(c.url ?? '')) errs.push('url must be http(s)');
    if (c.retries !== undefined && !(Number(c.retries) >= 0 && Number(c.retries) <= 20)) errs.push('retries must be 0-20');
    return errs;
  }

  async station(): Promise<Station> {
    const s = await this.ctx.db.getStation('ebms');
    if (!s.partyId) throw new Error('ebMS station is not configured (set our PartyId)');
    return { partyId: s.partyId, partyIdType: s.partyIdType || undefined };
  }

  private header(st: Station, c: Record<string, any>, messageId: string, conversationId: string, extra: Partial<Header> = {}): Header {
    return {
      from: { id: st.partyId, type: st.partyIdType, role: c.fromRole || undefined },
      to: { id: c.partyId, type: c.partyIdType || undefined, role: c.toRole || undefined },
      cpaId: c.cpaId, conversationId, service: c.service, serviceType: c.serviceType || undefined, action: c.action,
      messageId, timestamp: timestamp(), duplicateElimination: c.duplicateElimination !== false, ...extra,
    };
  }

  // ---- outbound ------------------------------------------------------------------
  async send(partner: PartnerRow, doc: OutboundDoc): Promise<SendResult> {
    const st = await this.station();
    const c = partner.config;
    const messageId = `${doc.id}@ipaas`;
    const conversationId = randomUUID();
    const receipt: Record<string, any> = { messageId, conversationId, ackRequested: c.ackRequested !== false, syncReply: c.syncReply !== false, attempts: 0 };
    return this.transmit(partner, st, doc, receipt);
  }

  private async transmit(partner: PartnerRow, st: Station, doc: { id: string; filename: string; contentType: string; content: Buffer }, receipt: Record<string, any>): Promise<SendResult> {
    const c = partner.config;
    const wantAck = c.ackRequested !== false;
    const sync = c.syncReply !== false;
    const retries = Number(c.retries ?? 3);
    const cid = `payload-0@ipaas`;
    const env: Envelope = {
      header: this.header(st, c, receipt.messageId, receipt.conversationId),
      ackRequested: wantAck ? { signed: false } : undefined,
      syncReply: sync && wantAck,
      manifest: [{ href: `cid:${cid}` }],
    };
    const { contentType, body } = mime(buildEnvelope(env), [{ cid, contentType: doc.contentType, filename: doc.filename, content: doc.content }]);
    const headers: Record<string, string> = { 'Content-Type': contentType, SOAPAction: '"ebXML"', 'MIME-Version': '1.0' };
    if (c.username) {
      const sec = await this.ctx.vault.get<{ password?: string }>(`partners/${partner.id}`);
      headers.Authorization = `Basic ${Buffer.from(`${c.username}:${sec?.password ?? ''}`).toString('base64')}`;
    }

    let lastError = '';
    // Sync mode retries immediately on transport errors; async mode resends from the retry timer.
    for (let attempt = 0; attempt <= (sync ? retries : 0); attempt++) {
      receipt.attempts = (receipt.attempts ?? 0) + 1;
      receipt.lastAttempt = Date.now();
      let res: Response;
      try {
        res = await fetch(c.url, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (e) {
        lastError = `POST ${c.url} failed: ${(e as Error).message}`;
        if (attempt < retries && sync) await sleep(Math.min(5000, 1000 * (attempt + 1)));
        continue;
      }
      const resBody = Buffer.from(await res.arrayBuffer());
      receipt.httpStatus = res.status;
      const ct = res.headers.get('content-type') ?? '';
      const reply = resBody.length && /xml|multipart/i.test(ct) ? safeParse(ct, resBody) : null;
      if (reply?.errors?.length) {
        receipt.errors = reply.errors;
        return { ok: false, messageId: receipt.messageId, receipt, error: `ebMS error from partner: ${describe(reply.errors)}` };
      }
      if (!res.ok) {
        lastError = `partner returned HTTP ${res.status}: ${resBody.toString('utf8').slice(0, 300)}`;
        if (res.status >= 500 && attempt < retries && sync) {
          await sleep(Math.min(5000, 1000 * (attempt + 1)));
          continue;
        }
        return { ok: false, messageId: receipt.messageId, receipt, error: lastError };
      }
      if (!wantAck) return { ok: true, status: 'sent', messageId: receipt.messageId, receipt };
      if (sync) {
        if (reply?.acknowledgment?.refToMessageId === receipt.messageId) {
          receipt.acknowledgment = { timestamp: reply!.acknowledgment!.timestamp, from: reply!.header.from.id };
          return { ok: true, status: 'delivered', messageId: receipt.messageId, receipt };
        }
        return { ok: false, messageId: receipt.messageId, receipt, error: 'Partner did not return a synchronous Acknowledgment' };
      }
      return { ok: true, status: 'awaiting-receipt', messageId: receipt.messageId, receipt };
    }
    return { ok: false, messageId: receipt.messageId, receipt, error: lastError };
  }

  /** Reliable messaging: resend unacknowledged async messages with the same MessageId. */
  private async retryDue(): Promise<void> {
    for (const p of await this.ctx.db.partnersByProtocol('ebms')) {
      if (p.config.syncReply !== false || p.config.ackRequested === false) continue;
      const interval = Number(p.config.retryIntervalSec ?? 60) * 1000;
      const retries = Number(p.config.retries ?? 3);
      for (const m of await this.ctx.db.listMessages({ partner: p.id, direction: 'out', limit: 200 })) {
        if (m.status !== 'awaiting-receipt' || !m.receipt) continue;
        const r = m.receipt as Record<string, any>;
        if (Date.now() - (r.lastAttempt ?? 0) < interval) continue;
        if ((r.attempts ?? 1) > retries) {
          await this.ctx.db.updateMessage(m.id, { status: 'failed', error: `No ebMS Acknowledgment after ${r.attempts} attempts` });
          continue;
        }
        const st = await this.station();
        const res = await this.transmit(p, st, { id: m.id, filename: m.filename ?? 'payload', contentType: m.content_type ?? 'application/octet-stream', content: await this.store.get(m.id) }, r);
        if (!res.ok) await this.ctx.db.updateMessage(m.id, { receipt: res.receipt ?? r, error: res.error });
        else await this.ctx.db.updateMessage(m.id, { receipt: res.receipt ?? r });
      }
    }
  }

  // ---- inbound -------------------------------------------------------------------
  async start(): Promise<void> {
    this.http = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
    this.http.removeAllContentTypeParsers();
    this.http.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const handler = async (req: any, reply: any) => {
      const r = await this.handleInbound(req.headers['content-type'] ?? '', req.body ?? Buffer.alloc(0));
      reply.code(r.status);
      if (r.contentType) reply.header('Content-Type', r.contentType);
      return reply.send(r.body ?? '');
    };
    this.http.post('/ebms', handler);
    this.http.post('/', handler);
    this.http.get('/ebms', async () => 'ebXML MS 2.0 endpoint: POST messages here.');
    await this.http.listen({ host: '0.0.0.0', port: this.opts.port });
    this.retryTimer = setInterval(() => void this.retryDue().catch((e) => this.ctx.log(`ebms retry: ${e.message}`)), 15000);
    this.ctx.log(`ebms endpoint on :${this.opts.port}/ebms`);
  }

  async stop(): Promise<void> {
    clearInterval(this.retryTimer);
    await this.http?.close();
  }

  async handleInbound(contentType: string, body: Buffer): Promise<{ status: number; contentType?: string; body?: Buffer | string }> {
    let st: Station;
    try {
      st = await this.station();
    } catch (e) {
      return { status: 503, body: (e as Error).message };
    }
    let msg: { env: Envelope; parts: Map<string, { headers: Record<string, string>; content: Buffer }> };
    try {
      msg = parseMessage(contentType, body);
    } catch (e) {
      const code = e instanceof EnvelopeError ? e.code : 'MimeProblem';
      return { status: 400, contentType: 'text/plain', body: `${code}: ${(e as Error).message}` };
    }
    const h = msg.env.header;
    if (h.to.id !== st.partyId) return this.errorReply(st, msg.env, null, [{ code: 'ValueNotRecognized', severity: 'Error', location: 'MessageHeader/To/PartyId', description: `Unknown To PartyId ${h.to.id}` }]);
    const partner = (await this.ctx.db.partnersByProtocol('ebms')).find((p) => p.config.partyId === h.from.id && (!p.config.cpaId || p.config.cpaId === h.cpaId));
    if (!partner) return this.errorReply(st, msg.env, null, [{ code: 'ValueNotRecognized', severity: 'Error', location: 'MessageHeader/From/PartyId', description: `Unknown partner ${h.from.id} / CPA ${h.cpaId}` }]);

    // MSH signals addressed to us.
    if (h.service === EBMS_SERVICE) {
      if (h.action === 'Ping') return this.signalReply(st, partner, msg.env, 'Pong');
      if (h.action === 'StatusRequest') {
        const ref = msg.env.statusRequest?.refToMessageId ?? '';
        const m = ref ? await this.ctx.db.findMessage('ebms', ref, 'in') : undefined;
        const status = !m ? 'NotRecognized' : m.partner_id !== partner.id ? 'UnAuthorized' : m.status === 'forwarded' ? 'Processed' : 'Received';
        const env: Envelope = {
          header: { ...this.replyHeader(st, msg.env), action: 'StatusResponse' },
          statusResponse: { refToMessageId: ref, status, timestamp: m ? new Date(m.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined },
        };
        return { status: 200, contentType: 'text/xml; charset=UTF-8', body: buildEnvelope(env) };
      }
      if (h.action === 'Acknowledgment' || h.action === 'MessageError') {
        await this.handleSignal(partner, msg.env);
        return { status: 204 };
      }
      return this.errorReply(st, msg.env, partner, [{ code: 'NotSupported', severity: 'Error', description: `Action ${h.action} is not supported` }]);
    }

    // Duplicate elimination: acknowledge again, don't deliver twice.
    const dup = await this.ctx.db.findMessage('ebms', h.messageId, 'in');
    if (!dup) {
      const refs = msg.env.manifest ?? [];
      const missing = refs.filter((r) => r.href.startsWith('cid:') && !msg.parts.has(r.href.slice(4)));
      if (missing.length) return this.errorReply(st, msg.env, partner, [{ code: 'MimeProblem', severity: 'Error', location: missing[0].href, description: 'Manifest references a missing MIME part' }]);
      const payloads = refs.length ? refs.map((r) => msg.parts.get(r.href.slice(4))!).filter(Boolean) : [...msg.parts.values()];
      if (!payloads.length) return this.errorReply(st, msg.env, partner, [{ code: 'Inconsistent', severity: 'Error', description: 'Message has no payload' }]);
      for (const [i, p] of payloads.entries()) {
        const disp = parseParams(p.headers['content-disposition']);
        await this.ctx.engine.receive(partner, {
          messageId: payloads.length > 1 ? `${h.messageId}#${i + 1}` : h.messageId,
          filename: disp.params.filename || parseParams(p.headers['content-type']).params.name || `${h.action}-${i + 1}.dat`,
          contentType: parseParams(p.headers['content-type']).value || 'application/octet-stream',
          content: p.content,
          receipt: { cpaId: h.cpaId, conversationId: h.conversationId, service: h.service, action: h.action, from: h.from, ackRequested: Boolean(msg.env.ackRequested), syncReply: Boolean(msg.env.syncReply) },
        });
      }
    } else {
      // Retransmission (our Acknowledgment was lost or late): acknowledge again, count it.
      const r = { ...(dup.receipt ?? {}) } as Record<string, any>;
      r.duplicates = (r.duplicates ?? 0) + 1;
      r.lastDuplicateAt = new Date().toISOString();
      await this.ctx.db.updateMessage(dup.id, { receipt: r });
      this.ctx.log(`ebms duplicate ${h.messageId} from ${h.from.id}: acknowledged, not delivered again`);
    }

    if (!msg.env.ackRequested) return { status: 204 };
    const ack: Envelope = {
      header: { ...this.replyHeader(st, msg.env), action: 'Acknowledgment' },
      acknowledgment: { refToMessageId: h.messageId },
    };
    if (msg.env.syncReply) return { status: 200, contentType: 'text/xml; charset=UTF-8', body: buildEnvelope(ack) };
    setImmediate(() => this.postSignal(partner, ack).catch((e) => this.ctx.log(`ebms async ack to ${partner.name}: ${e.message}`)));
    return { status: 204 };
  }

  private replyHeader(st: Station, req: Envelope): Header {
    const h = req.header;
    return {
      from: { id: st.partyId, type: h.to.type ?? st.partyIdType, role: h.to.role }, to: { id: h.from.id, type: h.from.type, role: h.from.role },
      cpaId: h.cpaId, conversationId: h.conversationId, service: EBMS_SERVICE, action: '', messageId: `${randomUUID()}@ipaas`,
      timestamp: timestamp(), refToMessageId: h.messageId,
    };
  }

  private signalReply(st: Station, _partner: PartnerRow, req: Envelope, action: string) {
    return { status: 200, contentType: 'text/xml; charset=UTF-8', body: buildEnvelope({ header: { ...this.replyHeader(st, req), action } }) };
  }

  private async errorReply(st: Station, req: Envelope, partner: PartnerRow | null, errors: EbmsError[]) {
    const env: Envelope = { header: { ...this.replyHeader(st, req), action: 'MessageError' }, errors };
    this.ctx.log(`ebms error for ${req.header.messageId}: ${describe(errors)}`);
    if (req.syncReply || !partner) return { status: 200, contentType: 'text/xml; charset=UTF-8', body: buildEnvelope(env) };
    setImmediate(() => this.postSignal(partner, env).catch((e) => this.ctx.log(`ebms async error to ${partner.name}: ${e.message}`)));
    return { status: 204 };
  }

  private async postSignal(partner: PartnerRow, env: Envelope): Promise<void> {
    const res = await fetch(partner.config.url, {
      method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '"ebXML"' }, body: buildEnvelope(env), signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /** Async Acknowledgment / MessageError for one of our messages. */
  private async handleSignal(partner: PartnerRow, env: Envelope): Promise<void> {
    const ref = env.acknowledgment?.refToMessageId ?? env.header.refToMessageId;
    const m = ref ? await this.ctx.db.findMessage('ebms', ref, 'out') : undefined;
    if (!m) {
      this.ctx.log(`ebms ${env.header.action} for unknown message ${ref}`);
      return;
    }
    const r = { ...(m.receipt ?? {}) } as Record<string, any>;
    if (env.header.action === 'Acknowledgment') {
      r.acknowledgment = { timestamp: env.acknowledgment?.timestamp, from: env.header.from.id };
      await this.ctx.db.updateMessage(m.id, { status: 'delivered', receipt: r, error: null });
    } else {
      r.errors = env.errors;
      await this.ctx.db.updateMessage(m.id, { status: 'failed', receipt: r, error: `ebMS error from partner: ${describe(env.errors ?? [])}` });
    }
    this.ctx.log(`ebms ${env.header.action} for ${ref} from ${partner.name}`);
  }
}

// ---- MIME (SOAP with Attachments) ------------------------------------------------

function mime(soap: string, payloads: { cid: string; contentType: string; filename: string; content: Buffer }[]) {
  const b = `----=_ebMS_${randomUUID()}`;
  const soapPart = buildEntity([['Content-ID', '<soap-part@ipaas>'], ['Content-Type', 'text/xml; charset=UTF-8']], Buffer.from(soap, 'utf8'));
  const parts = payloads.map((p) => buildEntity([
    ['Content-ID', `<${p.cid}>`], ['Content-Type', p.contentType], ['Content-Transfer-Encoding', 'binary'],
    ['Content-Disposition', `attachment; filename="${p.filename}"`],
  ], p.content));
  return {
    contentType: `multipart/related; type="text/xml"; boundary="${b}"; start="<soap-part@ipaas>"`,
    body: buildMultipart(b, [soapPart, ...parts]),
  };
}

/** Splits a SOAP-with-attachments message into the envelope and Content-ID-addressed parts. */
export function parseMessage(contentType: string, body: Buffer) {
  const ct = parseParams(contentType);
  const parts = new Map<string, { headers: Record<string, string>; content: Buffer }>();
  let soap: string;
  if (ct.value === 'multipart/related') {
    if (!ct.params.boundary) throw new EnvelopeError('MimeProblem', 'multipart without boundary');
    const raw = splitMultipart(body, ct.params.boundary).map(splitEntity);
    const start = ct.params.start?.replace(/^<|>$/g, '');
    const cidOf = (h: Record<string, string>) => (h['content-id'] ?? '').trim().replace(/^<|>$/g, '');
    const soapPart = (start && raw.find((p) => cidOf(p.headers) === start)) || raw[0];
    if (!soapPart) throw new EnvelopeError('MimeProblem', 'no SOAP part');
    soap = decodeTransfer(soapPart.headers, soapPart.body).toString('utf8');
    for (const p of raw) {
      if (p === soapPart) continue;
      parts.set(cidOf(p.headers), { headers: p.headers, content: decodeTransfer(p.headers, p.body) });
    }
  } else if (/xml/.test(ct.value)) {
    soap = body.toString('utf8');
  } else {
    throw new EnvelopeError('MimeProblem', `unexpected content type ${ct.value}`);
  }
  return { env: parseEnvelope(soap), parts };
}

function safeParse(contentType: string, body: Buffer): Envelope | null {
  try {
    return parseMessage(contentType, body).env;
  } catch {
    return null;
  }
}

const describe = (errs: EbmsError[]) => errs.map((e) => `${e.code}${e.location ? ` at ${e.location}` : ''}: ${e.description}`).join('; ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

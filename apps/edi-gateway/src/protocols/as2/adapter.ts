import Fastify, { type FastifyInstance } from 'fastify';
import type { PartnerRow } from '../../db';
import type { AdapterContext, OutboundDoc, ProtocolAdapter, SendResult } from '../../engine';
import { compress, isCompressedData, uncompress } from './ber';
import { CIPHERS, MIC_ALGS, decrypt, encrypt, mic, micalgName, sign, verify, type Cipher } from './cms';
import { boundary, buildEntity, buildMultipart, crlf, decodeTransfer, filenameOf, parseParams, splitEntity, splitMultipart, type Headers } from './mime';

/*
 * Station (ours):   edi_station.as2 = { as2Id, email? }   Vault edi/station/as2 = { certificate, privateKey }
 * Partner config:   as2Id, url, certificate (PEM), sign ('sha-256'|…|''), encrypt (cipher|''), compress,
 *                   mdn ('sync'|'async'|'none'), mdnSigned, requireSigned, requireEncrypted, subject?, username?
 * Partner Vault:    edi/partners/<id> = { password? }  (HTTP basic auth towards the partner)
 */

export interface MdnInfo {
  originalMessageId?: string;
  disposition?: string;
  /** processed | failed | … and the optional error/warning modifier */
  status?: string;
  modifier?: string;
  receivedMic?: string;
  micAlg?: string;
  signed: boolean;
  verified: boolean;
  verifyError?: string;
  text?: string;
}

interface Station { as2Id: string; certificate: string; privateKey: string; email?: string }

const stripQuotes = (s = '') => s.trim().replace(/^"(.*)"$/, '$1');
const quoteId = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/["\\]/g, '\\$&')}"` : s);
const b64lines = (buf: Buffer) => Buffer.from(buf.toString('base64').replace(/(.{76})/g, '$1\r\n'));

export class As2Adapter implements ProtocolAdapter {
  readonly protocol = 'as2' as const;
  private http?: FastifyInstance;

  constructor(private ctx: AdapterContext, private opts: { port: number; publicUrl: string; timeoutMs: number }) {}

  validate(c: Record<string, any>): string[] {
    const errs: string[] = [];
    if (!c.as2Id) errs.push('as2Id is required');
    if (c.as2Id && (c.as2Id.length > 128 || /[\x00-\x1f]/.test(c.as2Id))) errs.push('as2Id is invalid');
    if (c.url && !/^https?:\/\//.test(c.url)) errs.push('url must be http(s)');
    if ((c.sign || c.encrypt || c.mdnSigned || c.requireSigned) && !/-----BEGIN CERTIFICATE-----/.test(c.certificate ?? ''))
      errs.push('partner certificate (PEM) is required for signing/encryption');
    if (c.sign && !MIC_ALGS[c.sign]) errs.push(`unsupported signing algorithm ${c.sign}`);
    if (c.encrypt && !CIPHERS.includes(c.encrypt)) errs.push(`unsupported cipher ${c.encrypt}`);
    if (c.mdn && !['sync', 'async', 'none'].includes(c.mdn)) errs.push('mdn must be sync, async or none');
    return errs;
  }

  async station(): Promise<Station> {
    const cfg = await this.ctx.db.getStation('as2');
    const sec = await this.ctx.vault.get<{ certificate?: string; privateKey?: string }>('station/as2');
    if (!cfg.as2Id || !sec?.certificate || !sec.privateKey) throw new Error('AS2 station is not configured (set the AS2 ID and generate or upload a certificate)');
    return { as2Id: cfg.as2Id, email: cfg.email, certificate: sec.certificate, privateKey: sec.privateKey };
  }

  // ---- outbound -------------------------------------------------------------

  async send(partner: PartnerRow, doc: OutboundDoc): Promise<SendResult> {
    const c = partner.config;
    if (!c.url) return { ok: false, error: `AS2 partner ${partner.name} has no URL` };
    const st = await this.station();
    const messageId = `<${doc.id}@${st.as2Id.replace(/[^\w.-]/g, '_')}.ipaas>`;

    let entity = buildEntity([
      ['Content-Type', doc.contentType],
      ['Content-Transfer-Encoding', 'binary'],
      ['Content-Disposition', `attachment; filename="${doc.filename}"`],
    ], doc.content);
    if (c.compress) {
      entity = buildEntity([
        ['Content-Type', 'application/pkcs7-mime; smime-type=compressed-data; name="smime.p7z"'],
        ['Content-Transfer-Encoding', 'binary'],
        ['Content-Disposition', 'attachment; filename="smime.p7z"'],
      ], compress(entity));
    }
    const micAlg = c.sign || 'sha-256';
    const computedMic = mic(entity, micAlg);
    let outer = entity;
    if (c.sign) {
      const digest = MIC_ALGS[c.sign];
      const sig = await sign(entity, st.certificate, st.privateKey, digest);
      const b = boundary();
      const sigPart = buildEntity([
        ['Content-Type', 'application/pkcs7-signature; name="smime.p7s"'],
        ['Content-Transfer-Encoding', 'base64'],
        ['Content-Disposition', 'attachment; filename="smime.p7s"'],
      ], b64lines(sig));
      outer = buildEntity([['Content-Type', `multipart/signed; protocol="application/pkcs7-signature"; micalg=${micalgName(digest)}; boundary="${b}"`]],
        buildMultipart(b, [entity, sigPart]));
    }
    if (c.encrypt) {
      outer = buildEntity([
        ['Content-Type', 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"'],
        ['Content-Transfer-Encoding', 'binary'],
        ['Content-Disposition', 'attachment; filename="smime.p7m"'],
      ], await encrypt(outer, c.certificate, c.encrypt as Cipher));
    }

    const { headers: outerHeaders, body } = splitEntity(outer);
    const headers: Record<string, string> = {
      'AS2-Version': '1.2',
      'AS2-From': quoteId(st.as2Id),
      'AS2-To': quoteId(c.as2Id),
      'Message-ID': messageId,
      'MIME-Version': '1.0',
      Subject: c.subject || `AS2 message ${doc.filename}`,
      Date: new Date().toUTCString(),
      'Content-Type': outerHeaders['content-type'],
      'User-Agent': 'ipaas-edi-gateway',
    };
    // The HTTP headers carry the outer entity's MIME headers (for plain messages the MIC covers them).
    if (outerHeaders['content-transfer-encoding']) headers['Content-Transfer-Encoding'] = outerHeaders['content-transfer-encoding'];
    if (outerHeaders['content-disposition']) headers['Content-Disposition'] = outerHeaders['content-disposition'];
    const mdnMode = c.mdn || 'sync';
    if (mdnMode !== 'none') {
      headers['Disposition-Notification-To'] = st.email || st.as2Id;
      if (c.mdnSigned !== false) {
        headers['Disposition-Notification-Options'] = `signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, ${micalgName(MIC_ALGS[micAlg])}`;
      }
      if (mdnMode === 'async') headers['Receipt-Delivery-Option'] = (await this.ctx.db.getStation('as2')).publicUrl || this.opts.publicUrl;
    }
    if (c.username) {
      const sec = await this.ctx.vault.get<{ password?: string }>(`partners/${partner.id}`);
      headers.Authorization = `Basic ${Buffer.from(`${c.username}:${sec?.password ?? ''}`).toString('base64')}`;
    }

    const receipt: Record<string, any> = { messageId, mic: computedMic, micAlg, signed: Boolean(c.sign), encrypted: Boolean(c.encrypt), compressed: Boolean(c.compress), mdnMode };
    let res: Response;
    try {
      res = await fetch(c.url, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      return { ok: false, messageId, receipt, error: `AS2 POST ${c.url} failed: ${(e as Error).message}` };
    }
    const resBody = Buffer.from(await res.arrayBuffer());
    receipt.httpStatus = res.status;
    if (!res.ok) return { ok: false, messageId, receipt, error: `AS2 partner returned HTTP ${res.status}: ${resBody.toString('utf8').slice(0, 300)}` };
    if (mdnMode === 'none') return { ok: true, status: 'sent', messageId, receipt };
    if (mdnMode === 'async') return { ok: true, status: 'awaiting-receipt', messageId, receipt };

    const ct = res.headers.get('content-type');
    if (!ct || !resBody.length) return { ok: false, messageId, receipt, error: 'Partner did not return a synchronous MDN' };
    const mdn = await this.parseMdn(ct, resBody, c.certificate);
    receipt.mdn = mdn;
    const problem = this.mdnProblem(mdn, receipt as { mic: string }, c);
    return problem ? { ok: false, messageId, receipt, error: problem } : { ok: true, status: 'delivered', messageId, receipt };
  }

  /** Returns why an MDN does not confirm delivery, or null. */
  mdnProblem(mdn: MdnInfo, sent: { mic: string }, c: Record<string, any>): string | null {
    if (mdn.signed && !mdn.verified) return `MDN signature invalid: ${mdn.verifyError}`;
    if (c.mdnSigned !== false && !mdn.signed && c.requireSignedMdn) return 'MDN was not signed';
    if (mdn.status !== 'processed' || (mdn.modifier && /^(error|failure)/i.test(mdn.modifier))) return `Partner MDN: ${mdn.disposition}`;
    if (mdn.receivedMic && mdn.receivedMic !== sent.mic) return `MIC mismatch: sent ${sent.mic}, partner computed ${mdn.receivedMic}`;
    return null;
  }

  async parseMdn(contentType: string, body: Buffer, partnerCert?: string): Promise<MdnInfo> {
    let entity = buildEntity([['Content-Type', contentType]], body);
    const info: MdnInfo = { signed: false, verified: false };
    let { headers, body: b } = splitEntity(entity);
    let ct = parseParams(headers['content-type']);
    if (ct.value === 'multipart/signed') {
      const [signedPart, sigPart] = splitMultipart(b, ct.params.boundary);
      info.signed = true;
      const s = splitEntity(sigPart);
      try {
        if (!partnerCert) throw new Error('no partner certificate');
        await verify(signedPart, decodeTransfer(s.headers, s.body), partnerCert);
        info.verified = true;
      } catch (e) {
        info.verifyError = (e as Error).message;
      }
      entity = signedPart;
      ({ headers, body: b } = splitEntity(entity));
      ct = parseParams(headers['content-type']);
    }
    if (ct.value !== 'multipart/report') throw new Error(`MDN has unexpected content type ${ct.value}`);
    for (const part of splitMultipart(b, ct.params.boundary)) {
      const p = splitEntity(part);
      const pct = parseParams(p.headers['content-type']).value;
      const text = decodeTransfer(p.headers, p.body).toString('utf8');
      if (pct === 'message/disposition-notification') {
        const f = splitEntity(Buffer.from(`${text}\r\n\r\n`)).headers;
        const fields = Object.keys(f).length ? f : splitEntity(Buffer.from(`X: x\r\n${text}\r\n\r\n`)).headers;
        info.originalMessageId = fields['original-message-id'];
        info.disposition = fields.disposition;
        const d = /;\s*([\w-]+)(?:\/([^:]+(?::.*)?))?$/.exec(fields.disposition ?? '');
        info.status = d?.[1]?.toLowerCase();
        info.modifier = d?.[2]?.trim();
        const m = /^\s*([^,]+),\s*(\S+)/.exec(fields['received-content-mic'] ?? '');
        if (m) {
          info.receivedMic = m[1].trim();
          info.micAlg = m[2].trim();
        }
      } else if (pct.startsWith('text/')) {
        info.text = text.trim().slice(0, 1000);
      }
    }
    return info;
  }

  // ---- inbound --------------------------------------------------------------

  async start(): Promise<void> {
    this.http = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
    this.http.removeAllContentTypeParsers();
    this.http.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const handler = async (req: any, reply: any) => {
      const r = await this.handleInbound(req.headers as Record<string, string>, (req.body as Buffer) ?? Buffer.alloc(0));
      reply.code(r.status);
      for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.send(r.body);
    };
    this.http.post('/as2', handler);
    this.http.post('/', handler);
    this.http.get('/as2', async () => 'AS2 endpoint: POST AS2 messages here.');
    await this.http.listen({ host: '0.0.0.0', port: this.opts.port });
    this.ctx.log(`as2 endpoint on :${this.opts.port}/as2`);
  }

  async stop(): Promise<void> {
    await this.http?.close();
  }

  /** Processes one inbound HTTP request (message or async MDN). */
  async handleInbound(h: Record<string, string>, body: Buffer): Promise<{ status: number; headers: Record<string, string>; body: Buffer | string }> {
    const from = stripQuotes(h['as2-from']);
    const to = stripQuotes(h['as2-to']);
    const messageId = h['message-id'] ?? '';
    const contentType = h['content-type'] ?? '';
    let st: Station;
    try {
      st = await this.station();
    } catch (e) {
      return { status: 503, headers: {}, body: (e as Error).message };
    }
    if (!from || !to) return { status: 400, headers: {}, body: 'Missing AS2-From/AS2-To' };
    if (to !== st.as2Id) return { status: 403, headers: {}, body: `Unknown AS2-To ${to}` };
    const partner = (await this.ctx.db.partnersByProtocol('as2')).find((p) => p.config.as2Id === from);
    if (!partner) return { status: 403, headers: {}, body: `Unknown AS2-From ${from}` };

    if (await this.isMdn(contentType, body)) {
      await this.handleAsyncMdn(partner, contentType, body);
      return { status: 200, headers: {}, body: '' };
    }

    const wantsMdn = Boolean(h['disposition-notification-to']);
    const opts = parseMdnOptions(h['disposition-notification-options']);
    let mdnMicAlg = opts.micalg ?? 'sha-256';
    let disposition = 'processed';
    let micValue: string | undefined;

    try {
      const { entity, signed, encrypted, micEntity, signedMicalg } = await this.unwrap(entityHeaders(h), body, st, partner.config.certificate);
      if (signedMicalg && MIC_ALGS[signedMicalg]) mdnMicAlg = opts.micalg && MIC_ALGS[opts.micalg] ? opts.micalg : signedMicalg;
      if (partner.config.requireSigned && !signed) throw new As2Error('insufficient-message-security', 'message is not signed');
      if (partner.config.requireEncrypted && !encrypted) throw new As2Error('insufficient-message-security', 'message is not encrypted');
      micValue = mic(micEntity, mdnMicAlg);
      const p = splitEntity(entity);
      const content = decodeTransfer(p.headers, p.body);
      await this.ctx.engine.receive(partner, {
        messageId,
        filename: filenameOf(p.headers) ?? `${messageId.replace(/[<>]/g, '') || 'as2'}.dat`,
        contentType: parseParams(p.headers['content-type']).value || 'application/octet-stream',
        content,
        receipt: { signed, encrypted, mic: micValue, micAlg: mdnMicAlg, subject: h.subject },
      });
    } catch (e) {
      const code = e instanceof As2Error ? e.code : 'unexpected-processing-error';
      disposition = `processed/error: ${code}`;
      this.ctx.log(`as2 inbound ${messageId} from ${from}: ${code}: ${(e as Error).message}`);
    }

    if (!wantsMdn) return { status: disposition === 'processed' ? 200 : 400, headers: {}, body: disposition === 'processed' ? '' : disposition };
    const mdn = await this.buildMdn({ st, partnerAs2Id: from, originalMessageId: messageId, disposition, mic: micValue, micAlg: mdnMicAlg, signed: opts.signed });
    const asyncUrl = h['receipt-delivery-option'];
    if (asyncUrl) {
      setImmediate(() => this.deliverAsyncMdn(asyncUrl, mdn).catch((e) => this.ctx.log(`async MDN to ${asyncUrl}: ${e.message}`)));
      return { status: 200, headers: {}, body: '' };
    }
    return { status: 200, headers: mdn.headers, body: mdn.body };
  }

  private async unwrap(httpHeaders: [string, string][], body: Buffer, st: Station, partnerCert?: string) {
    let entity = buildEntity(httpHeaders, body);
    let signed = false;
    let encrypted = false;
    let micEntity: Buffer | undefined;
    let signedMicalg: string | undefined;
    for (let depth = 0; depth < 6; depth++) {
      const { headers, body: b } = splitEntity(entity);
      const ct = parseParams(headers['content-type']);
      if (ct.value === 'application/pkcs7-mime' || ct.value === 'application/x-pkcs7-mime') {
        const der = decodeTransfer(headers, b);
        if ((ct.params['smime-type'] ?? '').toLowerCase() === 'compressed-data' || isCompressedData(der)) {
          micEntity ??= entity;
          try {
            entity = uncompress(der);
          } catch (e) {
            throw new As2Error('decompression-failed', (e as Error).message);
          }
          continue;
        }
        try {
          entity = await decrypt(der, st.certificate, st.privateKey);
        } catch (e) {
          throw new As2Error('decryption-failed', (e as Error).message);
        }
        encrypted = true;
        continue;
      }
      if (ct.value === 'multipart/signed') {
        const [signedPart, sigPart] = splitMultipart(b, ct.params.boundary);
        const s = splitEntity(sigPart);
        if (!partnerCert) throw new As2Error('authentication-failed', 'no partner certificate to verify the signature');
        try {
          await verify(signedPart, decodeTransfer(s.headers, s.body), partnerCert);
        } catch (e) {
          throw new As2Error('authentication-failed', (e as Error).message);
        }
        signed = true;
        signedMicalg = ct.params.micalg?.toLowerCase();
        micEntity = signedPart;
        entity = signedPart;
        continue;
      }
      break;
    }
    return { entity, signed, encrypted, micEntity: micEntity ?? entity, signedMicalg };
  }

  private async isMdn(contentType: string, body: Buffer): Promise<boolean> {
    const ct = parseParams(contentType);
    if (ct.value === 'multipart/report') return true;
    if (ct.value !== 'multipart/signed') return false;
    try {
      const [first] = splitMultipart(body, ct.params.boundary);
      return parseParams(splitEntity(first).headers['content-type']).value === 'multipart/report';
    } catch {
      return false;
    }
  }

  private async handleAsyncMdn(partner: PartnerRow, contentType: string, body: Buffer): Promise<void> {
    const mdn = await this.parseMdn(contentType, body, partner.config.certificate);
    const original = mdn.originalMessageId ? await this.ctx.db.findMessage('as2', mdn.originalMessageId, 'out') : undefined;
    if (!original) {
      this.ctx.log(`as2 async MDN for unknown message ${mdn.originalMessageId}`);
      return;
    }
    const sent = (original.receipt ?? {}) as { mic: string };
    const problem = this.mdnProblem(mdn, sent, partner.config);
    await this.ctx.db.updateMessage(original.id, { status: problem ? 'failed' : 'delivered', receipt: { ...original.receipt, mdn }, error: problem });
    this.ctx.log(`as2 async MDN ${mdn.originalMessageId}: ${problem ?? 'delivered'}`);
  }

  async buildMdn(a: { st: Station; partnerAs2Id: string; originalMessageId: string; disposition: string; mic?: string; micAlg: string; signed: boolean }) {
    const ok = a.disposition === 'processed';
    const text = buildEntity([['Content-Type', 'text/plain; charset=us-ascii'], ['Content-Transfer-Encoding', '7bit']], Buffer.from(crlf(
      ok ? `The AS2 message ${a.originalMessageId} was received and processed.\n`
        : `The AS2 message ${a.originalMessageId} could not be processed: ${a.disposition}\n`)));
    const fields = [
      'Reporting-UA: ipaas-edi-gateway',
      `Original-Recipient: rfc822; ${a.st.as2Id}`,
      `Final-Recipient: rfc822; ${a.st.as2Id}`,
      `Original-Message-ID: ${a.originalMessageId}`,
      ...(ok && a.mic ? [`Received-Content-MIC: ${a.mic}, ${a.micAlg}`] : []),
      `Disposition: automatic-action/MDN-sent-automatically; ${a.disposition}`,
    ];
    const dispo = buildEntity([['Content-Type', 'message/disposition-notification'], ['Content-Transfer-Encoding', '7bit']], Buffer.from(`${fields.join('\r\n')}\r\n`));
    const rb = boundary();
    let entity = buildEntity([['Content-Type', `multipart/report; report-type=disposition-notification; boundary="${rb}"`]], buildMultipart(rb, [text, dispo]));
    if (a.signed) {
      const digest = MIC_ALGS[a.micAlg] ?? 'sha256';
      const sig = await sign(entity, a.st.certificate, a.st.privateKey, digest);
      const sb = boundary();
      const sigPart = buildEntity([
        ['Content-Type', 'application/pkcs7-signature; name="smime.p7s"'],
        ['Content-Transfer-Encoding', 'base64'],
        ['Content-Disposition', 'attachment; filename="smime.p7s"'],
      ], b64lines(sig));
      entity = buildEntity([['Content-Type', `multipart/signed; protocol="application/pkcs7-signature"; micalg=${micalgName(digest)}; boundary="${sb}"`]],
        buildMultipart(sb, [entity, sigPart]));
    }
    const { headers, body } = splitEntity(entity);
    return {
      headers: {
        'AS2-Version': '1.2', 'AS2-From': quoteId(a.st.as2Id), 'AS2-To': quoteId(a.partnerAs2Id),
        'Message-ID': `<mdn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@${a.st.as2Id.replace(/[^\w.-]/g, '_')}.ipaas>`,
        'MIME-Version': '1.0', 'Content-Type': headers['content-type'], Subject: 'Message Disposition Notification',
      } as Record<string, string>,
      body,
    };
  }

  private async deliverAsyncMdn(url: string, mdn: { headers: Record<string, string>; body: Buffer }): Promise<void> {
    const res = await fetch(url, { method: 'POST', headers: mdn.headers, body: new Uint8Array(mdn.body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}

class As2Error extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Rebuilds the outer MIME entity's headers from the HTTP request (same order the sender uses). */
function entityHeaders(h: Record<string, string>): [string, string][] {
  const out: [string, string][] = [['Content-Type', h['content-type'] ?? 'application/octet-stream']];
  if (h['content-transfer-encoding']) out.push(['Content-Transfer-Encoding', h['content-transfer-encoding']]);
  if (h['content-disposition']) out.push(['Content-Disposition', h['content-disposition']]);
  return out;
}

/** "signed-receipt-protocol=optional, pkcs7-signature; signed-receipt-micalg=optional, sha-256, sha1" */
export function parseMdnOptions(v?: string): { signed: boolean; micalg?: string } {
  if (!v) return { signed: false };
  const out: { signed: boolean; micalg?: string } = { signed: false };
  for (const part of v.split(';')) {
    const [k, rest = ''] = part.split('=');
    const vals = rest.split(',').map((x) => x.trim().toLowerCase());
    if (k.trim().toLowerCase() === 'signed-receipt-protocol') out.signed = vals.includes('pkcs7-signature');
    if (k.trim().toLowerCase() === 'signed-receipt-micalg') out.micalg = vals.slice(1).find((x) => MIC_ALGS[x]);
  }
  return out;
}

export type { Headers };

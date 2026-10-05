import { randomUUID } from 'node:crypto';
import type { Db, MessageRow, PartnerRow, Protocol } from './db';
import type { PayloadStore } from './store';
import type { Vault } from './vault';

export interface OutboundDoc {
  /** Our message id (also the edi_messages row id). */
  id: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export type SendResult =
  | { ok: true; status: 'sent' | 'delivered' | 'awaiting-receipt'; messageId: string; receipt?: Record<string, any> }
  | { ok: false; error: string; messageId?: string; receipt?: Record<string, any> };

export interface InboundDoc {
  messageId: string;
  filename: string;
  contentType: string;
  content: Buffer;
  /** Protocol details recorded with the message (signature, MIC, …). */
  receipt?: Record<string, any>;
}

export interface AdapterContext {
  db: Db;
  vault: Vault;
  engine: Engine;
  log: (msg: string) => void;
}

export interface ProtocolAdapter {
  protocol: Protocol;
  /** Validates non-secret partner settings; returns error messages. */
  validate(config: Record<string, any>): string[];
  send(partner: PartnerRow, doc: OutboundDoc): Promise<SendResult>;
  /** Starts listeners / pollers. */
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** Called after partners change (e.g. to restart pollers). */
  reload?(): Promise<void>;
}

/** Document handed to an inbound flow. */
export interface FlowPayload {
  edi: { protocol: Protocol; partner: string; messageId: string; id: string; filename: string; contentType: string; size: number; receivedAt: string };
  encoding: 'utf8' | 'base64';
  document: string;
}

export function asText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  const s = buf.toString('utf8');
  return Buffer.from(s, 'utf8').equals(buf) ? s : null;
}

export class Engine {
  private adapters = new Map<Protocol, ProtocolAdapter>();

  constructor(
    private db: Db,
    private store: PayloadStore,
    private gatewayUrl: string,
    private log: (msg: string) => void = console.log,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  register(a: ProtocolAdapter): void {
    this.adapters.set(a.protocol, a);
  }

  adapter(p: Protocol): ProtocolAdapter {
    const a = this.adapters.get(p);
    if (!a) throw new Error(`Protocol ${p} is not available`);
    return a;
  }

  protocols(): Protocol[] {
    return [...this.adapters.keys()];
  }

  /** Sends a document to a partner and records the outcome. Never throws for protocol errors. */
  async send(partnerRef: string, input: { filename?: string; contentType?: string; content: Buffer }): Promise<SendResult & { id?: string }> {
    const partner = await this.db.getPartner(partnerRef);
    if (!partner) return { ok: false, error: `Unknown EDI partner "${partnerRef}"` };
    if (!partner.enabled) return { ok: false, error: `EDI partner "${partner.name}" is disabled` };
    const id = randomUUID();
    const doc: OutboundDoc = {
      id,
      filename: sanitizeFilename(input.filename || `${id}.dat`),
      contentType: input.contentType || 'application/octet-stream',
      content: input.content,
    };
    await this.store.put(id, doc.content);
    await this.db.createMessage({
      id, direction: 'out', protocol: partner.protocol, partner_id: partner.id, partner_name: partner.name,
      status: 'sending', filename: doc.filename, content_type: doc.contentType, size: doc.content.length,
    });
    let result: SendResult;
    try {
      result = await this.adapter(partner.protocol).send(partner, doc);
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }
    await this.db.updateMessage(id, {
      status: result.ok ? result.status : 'failed',
      message_id: result.messageId ?? null,
      receipt: result.receipt ?? null,
      error: result.ok ? null : result.error,
    });
    this.log(`out ${partner.protocol} ${partner.name} ${doc.filename}: ${result.ok ? result.status : `failed: ${result.error}`}`);
    return { ...result, id };
  }

  /** Records an inbound document and forwards it to the partner's flow. */
  async receive(partner: PartnerRow, doc: InboundDoc): Promise<MessageRow> {
    const id = randomUUID();
    await this.store.put(id, doc.content);
    let msg = await this.db.createMessage({
      id, direction: 'in', protocol: partner.protocol, partner_id: partner.id, partner_name: partner.name,
      status: 'received', message_id: doc.messageId, filename: doc.filename, content_type: doc.contentType,
      size: doc.content.length, receipt: doc.receipt ?? null, flow_slug: partner.inbound_flow,
    });
    this.log(`in ${partner.protocol} ${partner.name} ${doc.filename} (${doc.content.length} bytes)`);
    // Forward after the protocol-level acknowledgement; don't block the sender.
    if (partner.inbound_flow) setImmediate(() => this.forward(msg.id).catch((e) => this.log(`forward ${id}: ${e.message}`)));
    return msg;
  }

  /** POSTs a received document to its flow on the gateway. */
  async forward(id: string): Promise<MessageRow> {
    const msg = await this.db.getMessage(id);
    if (!msg) throw new Error('message not found');
    if (msg.direction !== 'in' || !msg.flow_slug) throw new Error('message has no inbound flow');
    const content = await this.store.get(id);
    const text = asText(content);
    const payload: FlowPayload = {
      edi: {
        protocol: msg.protocol, partner: msg.partner_name ?? '', messageId: msg.message_id ?? '', id: msg.id,
        filename: msg.filename ?? '', contentType: msg.content_type ?? '', size: msg.size, receivedAt: new Date(msg.created_at).toISOString(),
      },
      encoding: text === null ? 'base64' : 'utf8',
      document: text ?? content.toString('base64'),
    };
    try {
      const res = await this.fetchImpl(`${this.gatewayUrl}/flows/${encodeURIComponent(msg.flow_slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-EDI-Message-Id': msg.id },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      return this.db.updateMessage(id, {
        status: res.ok ? 'forwarded' : 'forward-failed', flow_status: res.status,
        error: res.ok ? null : `Flow ${msg.flow_slug} returned ${res.status}: ${body.slice(0, 500)}`,
      });
    } catch (e) {
      return this.db.updateMessage(id, { status: 'forward-failed', flow_status: null, error: `Flow ${msg.flow_slug} unreachable: ${(e as Error).message}` });
    }
  }
}

export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(/[^\w.\-+@=~]/g, '_').replace(/^\.+/, '');
  return clean.slice(0, 200) || 'document.dat';
}

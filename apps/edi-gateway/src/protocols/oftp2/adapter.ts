import net from 'node:net';
import tls from 'node:tls';
import type { PartnerRow } from '../../db';
import type { AdapterContext, OutboundDoc, ProtocolAdapter, SendResult } from '../../engine';
import type { PayloadStore } from '../../store';
import { signOpaque, verifyOpaque } from '../as2/cms';
import { eerpSignedContent, stamp, toDsn, type Cmd } from './codec';
import { CIPHER_SUITES, FileServiceError, fileHash, securityLevel, unwrapFile, wrapFile, type Keys } from './files';
import { Channel, Session, type Hooks, type OutItem, type Peer, type SessionResult } from './session';

/*
 * Station:  edi_station.oftp2 = { odetteId }   Vault edi/station/oftp2 = { certificate, privateKey }
 * Partner:  odetteId, mode ('call' | 'wait'), host, port, tls, sdeb, credit, secureAuth, sign, encrypt, compress,
 *           cipherSuite, signedEerp, requireSigned, requireEncrypted, requireSignedEerp, certificate, pollIntervalSec
 * Vault:    edi/partners/<id> = { sendPassword, receivePassword }
 */

type PartnerPeer = Peer & { row: PartnerRow };
type SFID = Extract<Cmd, { type: 'SFID' }>;
const ID_RE = /^[A-Z0-9 /\-.&()]{1,25}$/;
const PW_RE = /^[A-Z0-9 /\-.&()]{0,8}$/;

export class Oftp2Adapter implements ProtocolAdapter {
  readonly protocol = 'oftp2' as const;
  private servers: (net.Server | tls.Server)[] = [];
  private locks = new Map<string, Promise<unknown>>();
  private pollTimer?: NodeJS.Timeout;
  private lastPoll = new Map<string, number>();

  constructor(private ctx: AdapterContext, private store: PayloadStore, private opts: { port: number; tlsPort: number }) {}

  validate(c: Record<string, any>): string[] {
    const errs: string[] = [];
    if (!ID_RE.test(c.odetteId ?? '')) errs.push('odetteId: 1-25 of A-Z 0-9 / - . & ( ) (e.g. O0013000000000000PARTNER)');
    if (!['call', 'wait'].includes(c.mode ?? 'call')) errs.push('mode must be call or wait');
    if ((c.mode ?? 'call') === 'call' && !c.host) errs.push('host is required in call mode');
    if (c.cipherSuite && !CIPHER_SUITES[c.cipherSuite]) errs.push(`unknown cipher suite ${c.cipherSuite}`);
    if ((c.encrypt || c.secureAuth || c.requireSigned || c.signedEerp) && !/BEGIN CERTIFICATE/.test(c.certificate ?? '')) {
      errs.push('partner certificate (PEM) is required for encryption, signature checks and secure authentication');
    }
    if (c.sdeb && !(c.sdeb >= 128 && c.sdeb <= 99999)) errs.push('sdeb must be 128-99999');
    if (c.credit && !(c.credit >= 1 && c.credit <= 999)) errs.push('credit must be 1-999');
    return errs;
  }

  // ---- identities ----------------------------------------------------------------
  async station(): Promise<{ odetteId: string; keys: Keys | null }> {
    const cfg = await this.ctx.db.getStation('oftp2');
    if (!cfg.odetteId) throw new Error('OFTP2 station is not configured (set our ODETTE ID)');
    const sec = await this.ctx.vault.get<{ certificate?: string; privateKey?: string }>('station/oftp2');
    return { odetteId: cfg.odetteId, keys: sec?.certificate && sec.privateKey ? { certificate: sec.certificate, privateKey: sec.privateKey } : null };
  }

  private async peerOf(row: PartnerRow): Promise<PartnerPeer> {
    const c = row.config;
    const sec = (await this.ctx.vault.get<{ sendPassword?: string; receivePassword?: string }>(`partners/${row.id}`)) ?? {};
    return {
      row, odetteId: c.odetteId, sendPassword: (sec.sendPassword ?? '').toUpperCase(), receivePassword: (sec.receivePassword ?? '').toUpperCase(),
      secureAuth: Boolean(c.secureAuth), certificate: c.certificate || undefined, sdeb: Number(c.sdeb) || 4096, credit: Number(c.credit) || 64,
    };
  }

  private async hooks(): Promise<Hooks<PartnerPeer>> {
    const st = await this.station();
    const items = new Map<string, { hash: string; sfid: Omit<SFID, 'type'> }>();
    return {
      own: st,
      log: this.ctx.log,
      lookup: async (code) => {
        const row = (await this.ctx.db.partnersByProtocol('oftp2')).find((p) => p.config.odetteId === code);
        return row ? this.peerOf(row) : null;
      },
      outbound: async (peer) => {
        const out: OutItem[] = [];
        for (const r of await this.ctx.db.pendingResponses(peer.row.id)) out.push({ kind: 'eerp', id: r.id, cmd: fromJson(r.cmd) });
        for (const m of await this.ctx.db.queuedMessages(peer.row.id)) {
          const c = peer.row.config;
          const suite = c.cipherSuite || '02';
          const services = { sign: Boolean(c.sign), compress: Boolean(c.compress), encrypt: Boolean(c.encrypt), suite };
          const original = await this.store.get(m.id);
          let data: Buffer;
          try {
            data = await wrapFile(original, services, st.keys, c.certificate);
          } catch (e) {
            await this.ctx.db.updateMessage(m.id, { status: 'failed', error: `OFTP2 file services: ${(e as Error).message}` });
            continue;
          }
          const { date, time } = stamp(new Date(m.created_at));
          const enveloped = services.sign || services.compress || services.encrypt;
          const sfid: Omit<SFID, 'type'> = {
            dsn: toDsn(m.filename ?? 'FILE'), date, time, user: '', dest: peer.odetteId, orig: st.odetteId, format: 'U', lrecl: 0,
            fileSize: Math.ceil(data.length / 1024), origSize: Math.ceil(original.length / 1024), restart: 0,
            security: securityLevel(services), cipher: enveloped ? suite : '00', compression: services.compress ? '1' : '0',
            envelope: enveloped ? '1' : '0', signedEerp: Boolean(c.signedEerp), description: m.filename ?? '',
          };
          items.set(m.id, { hash: fileHash(data, suite).toString('hex'), sfid });
          out.push({ kind: 'file', id: m.id, sfid, data });
        }
        return out;
      },
      eerpSent: async (_peer, item) => this.ctx.db.removeResponse(item.id),
      fileSent: async (_peer, item, r) => {
        const info = items.get(item.id)!;
        const messageId = `${info.sfid.dsn}:${info.sfid.date}${info.sfid.time}`;
        if (r.ok) {
          await this.ctx.db.updateMessage(item.id, {
            status: 'awaiting-receipt', message_id: messageId, error: null,
            receipt: { ...pick(info.sfid), hash: info.hash, cipherSuite: info.sfid.cipher, signedEerpRequested: info.sfid.signedEerp },
          });
        } else {
          await this.ctx.db.updateMessage(item.id, { status: 'failed', message_id: messageId, error: `Partner refused the file: ${r.text}` });
        }
      },
      acceptFile: (peer, sfid) => {
        const c = peer.row.config;
        if (sfid.envelope === '1' && sfid.cipher !== '00' && !CIPHER_SUITES[sfid.cipher]) return { ok: false, reason: '15', text: `cipher suite ${sfid.cipher}` };
        const enc = sfid.security === '01' || sfid.security === '03';
        const sig = sfid.security === '02' || sfid.security === '03';
        if (c.requireEncrypted && !enc) return { ok: false, reason: '17', text: 'unencrypted files are not accepted' };
        if (c.requireSigned && !sig) return { ok: false, reason: '20', text: 'unsigned files are not accepted' };
        return { ok: true };
      },
      fileReceived: async (peer, sfid, transmitted) => {
        let content: Buffer;
        try {
          content = await unwrapFile(transmitted, sfid, st.keys, peer.certificate);
        } catch (e) {
          if (e instanceof FileServiceError) return { ok: false, reason: e.reason, text: e.message.slice(0, 200) };
          return { ok: false, reason: '99', text: (e as Error).message.slice(0, 200) };
        }
        await this.ctx.engine.receive(peer.row, {
          messageId: `${sfid.dsn}:${sfid.date}${sfid.time}`,
          filename: sfid.description || sfid.dsn,
          contentType: 'application/octet-stream',
          content,
          receipt: { ...pick(sfid), security: sfid.security, cipherSuite: sfid.cipher, compressed: sfid.compression === '1', signedEerpRequested: sfid.signedEerp },
        });
        // The end-to-end response goes back when we next speak (this session or a later one).
        const suite = CIPHER_SUITES[sfid.cipher] ? sfid.cipher : '02';
        const eerp: Extract<Cmd, { type: 'EERP' }> = {
          type: 'EERP', dsn: sfid.dsn, date: sfid.date, time: sfid.time, user: '', dest: sfid.orig, orig: sfid.dest, hash: Buffer.alloc(0), signature: Buffer.alloc(0),
        };
        if (sfid.signedEerp && st.keys) {
          eerp.hash = fileHash(transmitted, suite);
          eerp.signature = await signOpaque(eerpSignedContent(eerp), st.keys.certificate, st.keys.privateKey, CIPHER_SUITES[suite].digest);
        }
        await this.ctx.db.addResponse(peer.row.id, toJson(eerp));
        return { ok: true };
      },
      responseReceived: async (peer, cmd) => {
        const messageId = `${cmd.dsn}:${cmd.date}${cmd.time}`;
        const m = await this.ctx.db.findByMessageId(peer.row.id, messageId);
        if (!m) {
          this.ctx.log(`oftp2 ${cmd.type} from ${peer.odetteId} for unknown file ${messageId}`);
          return;
        }
        const sent = (m.receipt ?? {}) as Record<string, any>;
        const response: Record<string, any> = { type: cmd.type, signed: cmd.signature.length > 0, hashPresent: cmd.hash.length > 0 };
        let problem: string | null = null;
        if (cmd.hash.length) {
          response.hashMatch = cmd.hash.toString('hex') === sent.hash;
          if (!response.hashMatch) problem = 'EERP hash does not match the transmitted file';
        }
        if (cmd.signature.length) {
          try {
            if (!peer.certificate) throw new Error('no partner certificate');
            const content = await verifyOpaque(cmd.signature, peer.certificate);
            response.verified = content.equals(cmd.type === 'EERP' ? eerpSignedContent(cmd) : content);
            if (!response.verified) problem = 'EERP signature does not cover this EERP';
          } catch (e) {
            response.verified = false;
            problem = `EERP signature invalid: ${(e as Error).message}`;
          }
        } else if (sent.signedEerpRequested && peer.row.config.requireSignedEerp) {
          problem = 'signed EERP was requested but an unsigned one was received';
        }
        if (cmd.type === 'NERP') {
          response.reason = cmd.reason;
          response.text = cmd.text;
          response.creator = cmd.creator;
          problem = `NERP ${cmd.reason} from ${cmd.creator}${cmd.text ? `: ${cmd.text}` : ''}`;
        }
        await this.ctx.db.updateMessage(m.id, { status: problem ? 'failed' : 'delivered', receipt: { ...sent, response }, error: problem });
        this.ctx.log(`oftp2 ${cmd.type} ${messageId} from ${peer.odetteId}: ${problem ?? 'delivered'}`);
      },
    };
  }

  // ---- outbound ------------------------------------------------------------------
  async send(partner: PartnerRow, doc: OutboundDoc): Promise<SendResult> {
    await this.ctx.db.updateMessage(doc.id, { status: 'queued' });
    if ((partner.config.mode ?? 'call') === 'wait') {
      return { ok: true, status: 'queued', messageId: toDsn(doc.filename), receipt: { mode: 'wait', note: 'delivered when the partner connects' } };
    }
    const session = await this.call(partner);
    const m = await this.ctx.db.getMessage(doc.id);
    const status = m?.status ?? 'queued';
    const receipt = { ...(m?.receipt ?? {}), session: { ok: session.ok, error: session.error, trace: session.trace.join(' ') } };
    if (status === 'delivered') return { ok: true, status: 'delivered', messageId: m!.message_id!, receipt };
    if (status === 'awaiting-receipt') return { ok: true, status: 'awaiting-receipt', messageId: m!.message_id!, receipt };
    if (status === 'failed') return { ok: false, messageId: m?.message_id ?? undefined, receipt, error: m?.error ?? 'failed' };
    return { ok: false, receipt, error: `OFTP2 session with ${partner.config.odetteId} failed: ${session.error ?? 'file not transmitted'}` };
  }

  /** Opens a session to the partner (we are the initiator), serialized per partner. */
  async call(partner: PartnerRow): Promise<SessionResult> {
    const prev = this.locks.get(partner.id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const c = partner.config;
      const peer = await this.peerOf(partner);
      const hooks = await this.hooks();
      const sock = await connect(c.host, Number(c.port) || (c.tls ? 6619 : 3305), Boolean(c.tls), c.tlsCa || c.certificate);
      return new Session(new Channel(sock), hooks).runInitiator(peer);
    }).catch((e): SessionResult => ({ ok: false, error: (e as Error).message, sent: 0, received: 0, responses: 0, trace: [] }));
    this.locks.set(partner.id, run);
    return run;
  }

  // ---- inbound -------------------------------------------------------------------
  async start(): Promise<void> {
    const accept = (sock: net.Socket) => {
      sock.setNoDelay(true);
      this.hooks()
        .then((h) => new Session(new Channel(sock), h).runResponder())
        .then((r) => this.ctx.log(`oftp2 inbound session ${r.peer ?? '?'}: ${r.ok ? `ok, ${r.received} received, ${r.sent} sent, ${r.responses} responses` : r.error}`))
        .catch((e) => {
          this.ctx.log(`oftp2 inbound session refused: ${e.message}`);
          sock.destroy();
        });
    };
    const plain = net.createServer(accept);
    await new Promise<void>((r) => plain.listen(this.opts.port, '0.0.0.0', () => r()));
    this.servers.push(plain);
    const keys = await this.ctx.vault.get<{ certificate?: string; privateKey?: string }>('station/oftp2').catch(() => null);
    if (keys?.certificate && keys.privateKey) {
      const secure = tls.createServer({ cert: keys.certificate, key: keys.privateKey, minVersion: 'TLSv1.2' }, accept);
      await new Promise<void>((r) => secure.listen(this.opts.tlsPort, '0.0.0.0', () => r()));
      this.servers.push(secure);
    }
    this.ctx.log(`oftp2 listening on :${this.opts.port}${this.servers.length > 1 ? ` and TLS :${this.opts.tlsPort}` : ' (TLS after a station certificate exists)'}`);
    this.pollTimer = setInterval(() => void this.pollDue(), 15000);
  }

  async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers = [];
  }

  /** Restarts listeners (e.g. after a new station certificate, so TLS is available). */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Call-mode partners with a poll interval are called periodically to pick up files and responses. */
  private async pollDue(): Promise<void> {
    for (const p of await this.ctx.db.partnersByProtocol('oftp2')) {
      const every = Number(p.config.pollIntervalSec) * 1000;
      if ((p.config.mode ?? 'call') !== 'call' || !every) continue;
      if (Date.now() - (this.lastPoll.get(p.id) ?? 0) < every) continue;
      this.lastPoll.set(p.id, Date.now());
      void this.call(p);
    }
  }
}

function connect(host: string, port: number, useTls: boolean, ca?: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(new Error(`cannot connect to ${host}:${port}: ${e.message}`));
    const sock = useTls
      ? tls.connect({ host, port, ca: ca ? [ca] : undefined, rejectUnauthorized: Boolean(ca), checkServerIdentity: () => undefined, minVersion: 'TLSv1.2' }, () => resolve(sock))
      : net.connect({ host, port }, () => resolve(sock));
    sock.setTimeout(15000, () => sock.destroy(new Error('connect timeout')));
    sock.once('error', onError);
    sock.once(useTls ? 'secureConnect' : 'connect', () => {
      sock.setTimeout(0);
      sock.off('error', onError);
    });
  });
}

const pick = (s: { dsn: string; date: string; time: string; dest: string; orig: string }) => ({ dsn: s.dsn, date: s.date, time: s.time, dest: s.dest, orig: s.orig });
const toJson = (c: Record<string, any>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Buffer.isBuffer(v) ? { b64: v.toString('base64') } : v]));
const fromJson = (c: Record<string, any>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v && typeof v === 'object' && 'b64' in v ? Buffer.from(v.b64, 'base64') : v])) as any;

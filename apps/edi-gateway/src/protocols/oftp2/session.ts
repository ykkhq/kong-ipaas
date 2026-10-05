import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { decrypt, encrypt } from '../as2/cms';
import { CodecError, Deframer, decode, encode, frame, fromDataBuffer, toDataBuffers, type Cmd } from './codec';
import type { Keys } from './files';

type CmdOf<T extends Cmd['type']> = Extract<Cmd, { type: T }>;
type SFID = CmdOf<'SFID'>;
type EERP = CmdOf<'EERP'>;
type NERP = CmdOf<'NERP'>;

export class SessionError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

/** One exchange buffer at a time over a TCP/TLS socket, with an inactivity timer. */
export class Channel {
  private deframer = new Deframer();
  private queue: Cmd[] = [];
  private waiters: { resolve: (c: Cmd) => void; reject: (e: Error) => void }[] = [];
  private failure: Error | null = null;
  trace: string[] = [];

  constructor(private sock: Socket, private timeoutMs = 120000) {
    sock.on('data', (chunk: Buffer) => {
      try {
        for (const oeb of this.deframer.push(chunk)) this.deliver(decode(oeb));
      } catch (e) {
        this.fail(e as Error);
      }
    });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('connection closed')));
  }

  private deliver(c: Cmd) {
    this.trace.push(`<- ${c.type}`);
    const w = this.waiters.shift();
    if (w) w.resolve(c);
    else this.queue.push(c);
  }

  private fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  send(c: Cmd): void {
    this.trace.push(`-> ${c.type}`);
    this.sock.write(frame(encode(c)));
  }

  recv(): Promise<Cmd> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SessionError('09', 'inactivity timeout')), this.timeoutMs);
      this.waiters.push({
        resolve: (c) => (clearTimeout(timer), resolve(c)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  close(): void {
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 2000).unref();
  }
}

/** Settings for the partner on the other end of a session. */
export interface Peer {
  /** Their ODETTE ID (SSIDCODE). */
  odetteId: string;
  /** Password we present in our SSID (assigned by the partner). */
  sendPassword: string;
  /** Password the partner must present; empty = not checked. */
  receivePassword: string;
  secureAuth: boolean;
  certificate?: string;
  sdeb: number;
  credit: number;
}

export type OutItem =
  | { kind: 'file'; id: string; sfid: Omit<SFID, 'type'>; data: Buffer }
  | { kind: 'eerp'; id: string; cmd: EERP | NERP };

export interface Hooks<P extends Peer = Peer> {
  own: { odetteId: string; keys: Keys | null };
  /** Responder: identify the caller from its SSID code. */
  lookup?(code: string): Promise<P | null>;
  outbound(peer: P): Promise<OutItem[]>;
  fileSent(peer: P, item: Extract<OutItem, { kind: 'file' }>, r: { ok: boolean; reason?: string; text?: string }): Promise<void>;
  eerpSent(peer: P, item: Extract<OutItem, { kind: 'eerp' }>): Promise<void>;
  /** A complete file arrived; return an EFNA reason to refuse it. */
  fileReceived(peer: P, sfid: SFID, transmitted: Buffer): Promise<{ ok: true } | { ok: false; reason: string; text: string }>;
  /** Validates an SFID before accepting it; return an SFNA reason to refuse. */
  acceptFile?(peer: P, sfid: SFID): { ok: true } | { ok: false; reason: string; text: string };
  responseReceived(peer: P, cmd: EERP | NERP): Promise<void>;
  log(msg: string): void;
}

export interface SessionResult {
  ok: boolean;
  reason?: string;
  error?: string;
  peer?: string;
  sent: number;
  received: number;
  responses: number;
  trace: string[];
}

/**
 * ODETTE-FTP 2.0 session (RFC 5024 4.x). The initiator speaks first; turns
 * change with CD; the side that has nothing to send right after the other side
 * handed over the turn ends the session with ESID.
 */
export class Session<P extends Peer = Peer> {
  private peer!: P;
  private sdeb = 0;
  private credit = 0;
  private stats = { sent: 0, received: 0, responses: 0 };

  constructor(private ch: Channel, private hooks: Hooks<P>, private ourSdeb = 4096, private ourCredit = 64) {}

  async runInitiator(peer: P): Promise<SessionResult> {
    this.peer = peer;
    return this.guard(async () => {
      this.expect(await this.ch.recv(), 'SSRM');
      this.ch.send(this.ssid(peer, peer.sdeb, peer.credit));
      const theirs = this.expect(await this.ch.recv(), 'SSID');
      this.checkSsid(theirs, peer);
      if (theirs.credit > peer.credit) throw new SessionError('02', `responder raised credit (${theirs.credit} > ${peer.credit})`);
      this.sdeb = Math.min(peer.sdeb, theirs.sdeb);
      this.credit = theirs.credit;
      if (peer.secureAuth) {
        this.ch.send({ type: 'SECD' });
        await this.answerChallenge();
        this.expect(await this.ch.recv(), 'SECD');
        await this.challenge();
      }
      await this.loop('speaker');
    });
  }

  async runResponder(): Promise<SessionResult> {
    return this.guard(async () => {
      this.ch.send({ type: 'SSRM' });
      const theirs = this.expect(await this.ch.recv(), 'SSID');
      const peer = await this.hooks.lookup!(theirs.code);
      if (!peer) throw new SessionError('03', `unknown ODETTE ID ${theirs.code}`);
      this.peer = peer;
      this.checkSsid(theirs, peer);
      this.sdeb = Math.min(theirs.sdeb, peer.sdeb, this.ourSdeb);
      this.credit = Math.min(theirs.credit, peer.credit, this.ourCredit);
      this.ch.send(this.ssid(peer, this.sdeb, this.credit));
      if (peer.secureAuth) {
        this.expect(await this.ch.recv(), 'SECD');
        await this.challenge();
        this.ch.send({ type: 'SECD' });
        await this.answerChallenge();
      }
      await this.loop('listener');
    });
  }

  private ssid(peer: P, sdeb: number, credit: number): Cmd {
    return {
      type: 'SSID', level: 5, code: this.hooks.own.odetteId, password: peer.sendPassword, sdeb, sr: 'B',
      compression: false, restart: false, special: false, credit, auth: peer.secureAuth, user: '',
    };
  }

  private checkSsid(s: CmdOf<'SSID'>, peer: P) {
    if (s.level !== 5) throw new SessionError('10', `protocol release level ${s.level} is not supported (need 5 = OFTP 2.0)`);
    if (s.code !== peer.odetteId) throw new SessionError('03', `unexpected ODETTE ID ${s.code}`);
    if (peer.receivePassword && s.password !== peer.receivePassword) throw new SessionError('04', 'invalid password');
    if (s.auth !== peer.secureAuth) throw new SessionError('12', `secure authentication mismatch (we ${peer.secureAuth ? 'require' : 'do not use'} it)`);
    if (s.sdeb < 128) throw new SessionError('07', `exchange buffer size ${s.sdeb} too small`);
  }

  /** Sends AUCH with a random challenge encrypted to the partner, verifies AURP. */
  private async challenge() {
    if (!this.peer.certificate) throw new SessionError('12', 'no partner certificate for secure authentication');
    const nonce = randomBytes(20);
    this.ch.send({ type: 'AUCH', challenge: await encrypt(nonce, this.peer.certificate, 'aes-256-cbc') });
    const r = this.expect(await this.ch.recv(), 'AURP');
    if (!timingSafeEqual(r.response, nonce)) throw new SessionError('11', 'invalid challenge response');
  }

  /** Receives AUCH, decrypts it with our key, answers with AURP. */
  private async answerChallenge() {
    const a = this.expect(await this.ch.recv(), 'AUCH');
    if (!this.hooks.own.keys) throw new SessionError('12', 'no OFTP2 certificate to answer the challenge');
    let plain: Buffer;
    try {
      plain = await decrypt(a.challenge, this.hooks.own.keys.certificate, this.hooks.own.keys.privateKey);
    } catch (e) {
      throw new SessionError('11', `cannot decrypt challenge: ${(e as Error).message}`);
    }
    if (plain.length !== 20) throw new SessionError('11', `challenge has ${plain.length} octets, expected 20`);
    this.ch.send({ type: 'AURP', response: plain });
  }

  private async loop(start: 'speaker' | 'listener') {
    let role = start;
    let handedOver = false; // the other side just gave us the turn
    for (let turns = 0; turns < 200; turns++) {
      if (role === 'speaker') {
        if ((await this.speak(handedOver)) === 'ended') return;
        role = 'listener';
      } else {
        if ((await this.listen()) === 'ended') return;
        role = 'speaker';
        handedOver = true;
      }
    }
    throw new SessionError('02', 'too many direction changes');
  }

  private async speak(handedOver: boolean): Promise<'ended' | 'cd'> {
    const items = await this.hooks.outbound(this.peer);
    if (!items.length) {
      if (handedOver) {
        this.ch.send({ type: 'ESID', reason: '00', text: '' });
        return 'ended';
      }
      this.ch.send({ type: 'CD' });
      return 'cd';
    }
    for (const item of items.filter((i): i is Extract<OutItem, { kind: 'eerp' }> => i.kind === 'eerp')) {
      this.ch.send(item.cmd);
      this.expect(await this.recvSkipCdt(), 'RTR');
      await this.hooks.eerpSent(this.peer, item);
    }
    for (const item of items.filter((i): i is Extract<OutItem, { kind: 'file' }> => i.kind === 'file')) {
      this.ch.send({ type: 'SFID', ...item.sfid, restart: 0 });
      const answer = await this.ch.recv();
      if (answer.type === 'SFNA') {
        await this.hooks.fileSent(this.peer, item, { ok: false, reason: answer.reason, text: `SFNA ${answer.reason}${answer.text ? `: ${answer.text}` : ''}` });
        continue;
      }
      this.expect(answer, 'SFPA');
      let credit = this.credit;
      for (const payload of toDataBuffers(item.data, this.sdeb)) {
        if (credit === 0) {
          this.expect(await this.ch.recv(), 'CDT');
          credit = this.credit;
        }
        this.ch.send({ type: 'DATA', payload });
        credit--;
      }
      this.ch.send({ type: 'EFID', records: 0, units: item.data.length });
      const end = await this.recvSkipCdt();
      if (end.type === 'EFNA') {
        await this.hooks.fileSent(this.peer, item, { ok: false, reason: end.reason, text: `EFNA ${end.reason}${end.text ? `: ${end.text}` : ''}` });
        continue;
      }
      const efpa = this.expect(end, 'EFPA');
      this.stats.sent++;
      await this.hooks.fileSent(this.peer, item, { ok: true });
      if (efpa.cd) break; // listener asked for the turn
    }
    this.ch.send({ type: 'CD' });
    return 'cd';
  }

  /** A CDT can still arrive after the last data buffer; it is harmless there. */
  private async recvSkipCdt(): Promise<Cmd> {
    for (;;) {
      const c = await this.ch.recv();
      if (c.type !== 'CDT') return c;
    }
  }

  private async listen(): Promise<'ended' | 'speaker'> {
    let file: { sfid: SFID; parts: Buffer[]; credit: number } | null = null;
    for (;;) {
      const c = await this.ch.recv();
      switch (c.type) {
        case 'SFID': {
          if (file) throw new SessionError('02', 'SFID while a file is open');
          const refusal = this.validateSfid(c) ?? this.hooks.acceptFile?.(this.peer, c);
          if (refusal && !refusal.ok) {
            this.ch.send({ type: 'SFNA', reason: refusal.reason, retry: false, text: refusal.text });
            break;
          }
          this.ch.send({ type: 'SFPA', count: 0 });
          file = { sfid: c, parts: [], credit: this.credit };
          break;
        }
        case 'DATA': {
          if (!file) throw new SessionError('02', 'DATA outside a file');
          file.parts.push(fromDataBuffer(c.payload).data);
          if (--file.credit === 0) {
            this.ch.send({ type: 'CDT' });
            file.credit = this.credit;
          }
          break;
        }
        case 'EFID': {
          if (!file) throw new SessionError('02', 'EFID outside a file');
          const data = Buffer.concat(file.parts);
          const sfid = file.sfid;
          file = null;
          if (c.units !== data.length) {
            this.ch.send({ type: 'EFNA', reason: '11', text: `unit count ${c.units} but received ${data.length} octets` });
            break;
          }
          const r = await this.hooks.fileReceived(this.peer, sfid, data);
          if (r.ok) {
            this.stats.received++;
            this.ch.send({ type: 'EFPA', cd: false });
          } else {
            this.ch.send({ type: 'EFNA', reason: r.reason, text: r.text });
          }
          break;
        }
        case 'EERP':
        case 'NERP':
          this.stats.responses++;
          await this.hooks.responseReceived(this.peer, c);
          this.ch.send({ type: 'RTR' });
          break;
        case 'CD':
          if (file) throw new SessionError('02', 'CD while a file is open');
          return 'speaker';
        case 'ESID':
          if (c.reason !== '00') throw new SessionError(c.reason, `partner ended the session: ${c.reason}${c.text ? ` ${c.text}` : ''}`);
          return 'ended';
        default:
          throw new SessionError('02', `unexpected ${c.type} while listening`);
      }
    }
  }

  private validateSfid(s: SFID): { ok: false; reason: string; text: string } | null {
    if (s.dest !== this.hooks.own.odetteId) return { ok: false, reason: '02', text: `unknown destination ${s.dest}` };
    if (s.orig !== this.peer.odetteId) return { ok: false, reason: '03', text: `originator ${s.orig} does not match the session partner` };
    if (!['U', 'T', 'F', 'V'].includes(s.format)) return { ok: false, reason: '04', text: `format ${s.format}` };
    return null;
  }

  private expect<T extends Cmd['type']>(c: Cmd, type: T): CmdOf<T> {
    if (c.type === 'ESID') throw new SessionError(c.reason, `partner ended the session: ${c.reason}${c.text ? ` ${c.text}` : ''}`);
    if (c.type !== type) throw new SessionError('02', `expected ${type}, got ${c.type}`);
    return c as CmdOf<T>;
  }

  /** Runs a phase; on failure tells the partner why (ESID) and reports the reason. */
  private async guard(fn: () => Promise<void>): Promise<SessionResult> {
    try {
      await fn();
      return { ok: true, peer: this.peer?.odetteId, ...this.stats, trace: this.ch.trace };
    } catch (e) {
      const err = e as Error;
      const reason = e instanceof SessionError ? e.reason : e instanceof CodecError ? '06' : '99';
      const fromPartner = /partner ended the session/.test(err.message);
      if (!fromPartner) {
        try {
          this.ch.send({ type: 'ESID', reason: /^\d\d$/.test(reason) ? reason : '99', text: err.message.slice(0, 100) });
        } catch {
          /* connection already gone */
        }
      }
      this.hooks.log(`oftp2 session ${this.peer?.odetteId ?? '?'}: ${err.message}`);
      return { ok: false, reason, error: err.message, peer: this.peer?.odetteId, ...this.stats, trace: this.ch.trace };
    } finally {
      this.ch.close();
    }
  }
}

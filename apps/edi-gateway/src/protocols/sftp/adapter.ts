import { createHash, randomUUID } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { open, readdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import ssh2, { type Connection, type SFTPWrapper } from 'ssh2';
import type { PartnerRow } from '../../db';
import type { AdapterContext, OutboundDoc, ProtocolAdapter, SendResult } from '../../engine';
import { PartnerFs } from './vfs';

const { Server, Client, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

/*
 * Partner config (non-secret):
 *   mode: 'remote' | 'hosted'
 *   remote: host, port=22, username, uploadDir='.', pollDir?, archiveDir?, hostKeySha256?
 *   hosted: username, authorizedKey? (OpenSSH public key)
 * Vault edi/partners/<id>: password? | privateKey? + passphrase?
 * Vault edi/station/sftp: hostKey (private key of our hosted server)
 */

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

interface Opts {
  dataDir: string;
  port: number;
  pollIntervalMs: number;
}

export class SftpAdapter implements ProtocolAdapter {
  readonly protocol = 'sftp' as const;
  private server?: InstanceType<typeof Server>;
  private pollTimer?: NodeJS.Timeout;
  private polling = new Set<string>();

  constructor(private ctx: AdapterContext, private opts: Opts) {}

  validate(c: Record<string, any>): string[] {
    const errs: string[] = [];
    if (c.mode !== 'remote' && c.mode !== 'hosted') errs.push('mode must be "remote" or "hosted"');
    if (c.mode === 'remote') {
      if (!c.host) errs.push('host is required');
      if (!c.username) errs.push('username is required');
      if (c.port && !(Number(c.port) > 0 && Number(c.port) < 65536)) errs.push('port is invalid');
      if (c.hostKeySha256 && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(c.hostKeySha256)) errs.push('hostKeySha256 must look like SHA256:…(43 chars)');
    }
    if (c.mode === 'hosted') {
      if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(c.username ?? '')) errs.push('username is required (letters, digits, _ . -)');
      if (c.authorizedKey) {
        const k = utils.parseKey(c.authorizedKey);
        if (k instanceof Error || Array.isArray(k)) errs.push('authorizedKey is not a valid public key');
      }
    }
    return errs;
  }

  // ---- outbound -------------------------------------------------------------

  async send(partner: PartnerRow, doc: OutboundDoc): Promise<SendResult> {
    const c = partner.config;
    if (c.mode === 'hosted') {
      // The partner picks it up from /outbox. Write under a temp name, then rename.
      const fs = new PartnerFs(this.opts.dataDir, partner.name);
      await fs.init();
      const tmp = fs.real(`/outbox/.${doc.id}.part`);
      await writeFile(tmp, doc.content, { mode: 0o640 });
      await rename(tmp, fs.real(`/outbox/${doc.filename}`));
      return { ok: true, status: 'sent', messageId: `/outbox/${doc.filename}`, receipt: { mode: 'hosted', path: `/outbox/${doc.filename}` } };
    }
    const dir = (c.uploadDir || '.').replace(/\/+$/, '') || '.';
    const finalPath = `${dir}/${doc.filename}`;
    const tmpPath = `${dir}/.${doc.filename}.${doc.id.slice(0, 8)}.part`;
    try {
      return await this.withRemote(partner, async (sftp, hostKey) => {
        await sftpCall<void>((cb) => sftp.writeFile(tmpPath, doc.content, cb));
        try {
          await sftpCall<void>((cb) => sftp.rename(tmpPath, finalPath, cb));
        } catch {
          // SFTPv3 rename fails if the target exists: replace it.
          await sftpCall<void>((cb) => sftp.unlink(finalPath, cb)).catch(() => undefined);
          await sftpCall<void>((cb) => sftp.rename(tmpPath, finalPath, cb));
        }
        return { ok: true, status: 'delivered', messageId: finalPath, receipt: { mode: 'remote', path: finalPath, hostKey } };
      });
    } catch (e) {
      return { ok: false, error: `SFTP upload to ${c.host}: ${(e as Error).message}` };
    }
  }

  /** Connects to a remote partner, verifying the pinned host key. */
  private async withRemote<T>(partner: PartnerRow, fn: (sftp: SFTPWrapper, hostKey: string) => Promise<T>): Promise<T> {
    const c = partner.config;
    const secret = (await this.ctx.vault.get<{ password?: string; privateKey?: string; passphrase?: string }>(`partners/${partner.id}`)) ?? {};
    const conn = new Client();
    let seenKey = '';
    try {
      await new Promise<void>((resolve, reject) => {
        conn.once('ready', () => resolve()).once('error', reject);
        conn.connect({
          host: c.host,
          port: Number(c.port || 22),
          username: c.username,
          password: secret.password,
          privateKey: secret.privateKey,
          passphrase: secret.passphrase,
          readyTimeout: 15000,
          hostVerifier: (key: Buffer) => {
            seenKey = fingerprint(key);
            return !c.hostKeySha256 || c.hostKeySha256 === seenKey;
          },
        });
      }).catch((e) => {
        if (c.hostKeySha256 && seenKey && seenKey !== c.hostKeySha256) {
          throw new Error(`host key mismatch: expected ${c.hostKeySha256}, got ${seenKey}`);
        }
        throw e;
      });
      const sftp = await sftpCall<SFTPWrapper>((cb) => conn.sftp(cb));
      return await fn(sftp, seenKey);
    } finally {
      conn.end();
    }
  }

  /** Connects and lists the poll directory: used by the UI to check settings and learn the host key. */
  async test(partner: PartnerRow): Promise<{ ok: boolean; hostKey?: string; files?: string[]; error?: string }> {
    if (partner.config.mode !== 'remote') return { ok: true };
    try {
      return await this.withRemote(partner, async (sftp, hostKey) => {
        const dir = partner.config.pollDir || partner.config.uploadDir || '.';
        const list = await sftpCall<{ filename: string }[]>((cb) => sftp.readdir(dir, cb));
        return { ok: true, hostKey, files: list.map((f) => f.filename).slice(0, 50) };
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---- inbound: polling remote partners -------------------------------------

  private async pollAll(): Promise<void> {
    for (const p of await this.ctx.db.partnersByProtocol('sftp')) {
      if (p.config.mode !== 'remote' || !p.config.pollDir || this.polling.has(p.id)) continue;
      this.polling.add(p.id);
      this.pollOne(p)
        .catch((e) => this.ctx.log(`sftp poll ${p.name}: ${(e as Error).message}`))
        .finally(() => this.polling.delete(p.id));
    }
  }

  async pollOne(p: PartnerRow): Promise<number> {
    const dir = p.config.pollDir.replace(/\/+$/, '');
    return this.withRemote(p, async (sftp) => {
      const list = await sftpCall<{ filename: string; attrs: { mode: number; size: number } }[]>((cb) => sftp.readdir(dir, cb));
      let n = 0;
      for (const f of list) {
        if (PartnerFs.isTemp(f.filename) || (f.attrs.mode & fsc.S_IFMT) !== fsc.S_IFREG) continue;
        const remote = `${dir}/${f.filename}`;
        const content = await sftpCall<Buffer>((cb) => sftp.readFile(remote, cb));
        await this.ctx.engine.receive(p, { messageId: remote, filename: f.filename, contentType: 'application/octet-stream', content });
        if (p.config.archiveDir) {
          await sftpCall<void>((cb) => sftp.rename(remote, `${p.config.archiveDir.replace(/\/+$/, '')}/${f.filename}`, cb));
        } else {
          await sftpCall<void>((cb) => sftp.unlink(remote, cb));
        }
        n++;
      }
      return n;
    });
  }

  // ---- inbound: hosted server -------------------------------------------------

  async start(): Promise<void> {
    const hostKey = await this.hostKey();
    this.server = new Server({ hostKeys: [hostKey] }, (client) => this.onClient(client));
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, '0.0.0.0', () => resolve()));
    const pub = utils.parseKey(hostKey);
    if (!(pub instanceof Error) && !Array.isArray(pub)) this.ctx.log(`sftp server on :${this.opts.port}, host key ${fingerprint(pub.getPublicSSH())}`);
    this.pollTimer = setInterval(() => void this.pollAll(), this.opts.pollIntervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Our server's host key, generated once and kept in Vault. */
  async hostKey(): Promise<string> {
    const s = await this.ctx.vault.get<{ hostKey?: string }>('station/sftp');
    if (s?.hostKey) return s.hostKey;
    const { private: priv } = utils.generateKeyPairSync('ed25519');
    await this.ctx.vault.merge('station/sftp', { hostKey: priv });
    return priv;
  }

  async hostKeyFingerprint(): Promise<string> {
    const k = utils.parseKey(await this.hostKey());
    if (k instanceof Error || Array.isArray(k)) throw new Error('invalid host key');
    return fingerprint(k.getPublicSSH());
  }

  private onClient(client: Connection): void {
    let partner: PartnerRow | undefined;
    client.on('authentication', async (authCtx) => {
      try {
        const candidates = (await this.ctx.db.partnersByProtocol('sftp')).filter((p) => p.config.mode === 'hosted' && p.config.username === authCtx.username);
        const p = candidates[0];
        if (!p) return authCtx.reject(['password', 'publickey']);
        if (authCtx.method === 'password') {
          const secret = await this.ctx.vault.get<{ password?: string }>(`partners/${p.id}`);
          if (secret?.password && safeEqual(secret.password, authCtx.password)) {
            partner = p;
            return authCtx.accept();
          }
        } else if (authCtx.method === 'publickey' && p.config.authorizedKey) {
          const allowed = utils.parseKey(p.config.authorizedKey);
          if (!(allowed instanceof Error) && !Array.isArray(allowed) && authCtx.key.algo === allowed.type && authCtx.key.data.equals(allowed.getPublicSSH())) {
            if (!authCtx.signature) return authCtx.accept(); // key probe
            if (allowed.verify(authCtx.blob!, authCtx.signature, authCtx.hashAlgo) === true) {
              partner = p;
              return authCtx.accept();
            }
          }
        }
        authCtx.reject(['password', 'publickey']);
      } catch (e) {
        this.ctx.log(`sftp auth error: ${(e as Error).message}`);
        authCtx.reject();
      }
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          // Accept synchronously: packets that arrive before handlers exist are lost.
          const fs = new PartnerFs(this.opts.dataDir, partner!.name);
          try {
            fs.initSync();
            this.serve(acceptSftp(), fs, partner!);
          } catch (e) {
            this.ctx.log(`sftp session: ${(e as Error).message}`);
          }
        });
      });
    });
    client.on('error', (e) => this.ctx.log(`sftp client error: ${e.message}`));
  }

  /** Minimal SFTP v3 server over the partner's chroot. */
  private serve(sftp: SFTPWrapper, fs: PartnerFs, partner: PartnerRow): void {
    type H = { kind: 'file'; fh: FileHandle; virtual: string; write: boolean } | { kind: 'dir'; virtual: string; done: boolean };
    const handles = new Map<number, H>();
    let next = 0;
    const handle = (h: H) => {
      const id = next++;
      handles.set(id, h);
      const b = Buffer.alloc(4);
      b.writeUInt32BE(id);
      return b;
    };
    const get = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
    const fail = (reqid: number, code = STATUS_CODE.FAILURE) => sftp.status(reqid, code);
    const attrsOf = (s: { mode: number; size: number; uid: number; gid: number; atimeMs: number; mtimeMs: number }) => ({
      mode: s.mode, size: s.size, uid: 0, gid: 0, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000),
    });
    const resolve = (p: string) => {
      const v = PartnerFs.normalize(p);
      return v && PartnerFs.area(v) ? v : null;
    };
    const complete = async (virtual: string) => {
      const name = path.posix.basename(virtual);
      if (path.posix.dirname(virtual) !== '/inbox' || PartnerFs.isTemp(name)) return;
      const real = fs.real(virtual);
      const content = await readFile(real);
      await this.ctx.engine.receive(partner, { messageId: virtual, filename: name, contentType: 'application/octet-stream', content });
      await rename(real, fs.real(`/.processed/${randomUUID()}-${name}`));
    };

    sftp.on('REALPATH', (reqid, p) => {
      const v = PartnerFs.normalize(p) ?? '/';
      sftp.name(reqid, [{ filename: v, longname: v, attrs: {} as any }]);
    });
    const statHandler = async (reqid: number, p: string) => {
      const v = resolve(p);
      if (!v) return fail(reqid, STATUS_CODE.NO_SUCH_FILE);
      try {
        sftp.attrs(reqid, attrsOf(await stat(fs.real(v))) as any);
      } catch {
        fail(reqid, STATUS_CODE.NO_SUCH_FILE);
      }
    };
    sftp.on('STAT', statHandler);
    sftp.on('LSTAT', statHandler);
    sftp.on('OPENDIR', async (reqid, p) => {
      const v = resolve(p);
      if (!v) return fail(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.handle(reqid, handle({ kind: 'dir', virtual: v, done: false }));
    });
    sftp.on('READDIR', async (reqid, hb) => {
      const h = get(hb);
      if (!h || h.kind !== 'dir') return fail(reqid);
      if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
      h.done = true;
      const names = h.virtual === '/' ? ['inbox', 'outbox'] : (await readdir(fs.real(h.virtual))).filter((n) => !n.startsWith('.'));
      const entries = [];
      for (const n of names) {
        const s = await stat(fs.real(path.posix.join(h.virtual, n)));
        entries.push({ filename: n, longname: `${s.isDirectory() ? 'd' : '-'}rw-r----- 1 edi edi ${s.size} Jan 1 00:00 ${n}`, attrs: attrsOf(s) as any });
      }
      // SFTPv3: an empty batch must be EOF, not an empty NAME response.
      if (!entries.length) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.name(reqid, entries);
    });
    sftp.on('OPEN', async (reqid, p, flags) => {
      const v = resolve(p);
      const area = v && PartnerFs.area(v);
      const write = Boolean(flags & OPEN_MODE.WRITE);
      if (!v || area === 'root' || (write && area !== 'inbox') || (!write && area !== 'outbox')) return fail(reqid, STATUS_CODE.PERMISSION_DENIED);
      try {
        const mode = write ? (flags & OPEN_MODE.APPEND ? 'a' : 'w') : 'r';
        sftp.handle(reqid, handle({ kind: 'file', fh: await open(fs.real(v), mode, 0o640), virtual: v, write }));
      } catch {
        fail(reqid, STATUS_CODE.NO_SUCH_FILE);
      }
    });
    sftp.on('READ', async (reqid, hb, offset, length) => {
      const h = get(hb);
      if (!h || h.kind !== 'file') return fail(reqid);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await h.fh.read(buf, 0, length, offset);
      if (!bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, bytesRead));
    });
    sftp.on('WRITE', async (reqid, hb, offset, data) => {
      const h = get(hb);
      if (!h || h.kind !== 'file' || !h.write) return fail(reqid);
      await h.fh.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    });
    sftp.on('FSTAT', async (reqid, hb) => {
      const h = get(hb);
      if (!h || h.kind !== 'file') return fail(reqid);
      sftp.attrs(reqid, attrsOf(await h.fh.stat()) as any);
    });
    sftp.on('CLOSE', async (reqid, hb) => {
      const h = get(hb);
      if (!h) return fail(reqid);
      handles.delete(hb.readUInt32BE(0));
      if (h.kind === 'file') {
        await h.fh.close();
        if (h.write) {
          try {
            await complete(h.virtual);
          } catch (e) {
            this.ctx.log(`sftp receive ${h.virtual}: ${(e as Error).message}`);
            return fail(reqid);
          }
        }
      }
      sftp.status(reqid, STATUS_CODE.OK);
    });
    sftp.on('REMOVE', async (reqid, p) => {
      const v = resolve(p);
      if (!v || PartnerFs.area(v) !== 'outbox') return fail(reqid, STATUS_CODE.PERMISSION_DENIED);
      try {
        await unlink(fs.real(v));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch {
        fail(reqid, STATUS_CODE.NO_SUCH_FILE);
      }
    });
    sftp.on('RENAME', async (reqid, from, to) => {
      const a = resolve(from);
      const b = resolve(to);
      if (!a || !b || PartnerFs.area(a) !== 'inbox' || PartnerFs.area(b) !== 'inbox') return fail(reqid, STATUS_CODE.PERMISSION_DENIED);
      try {
        await rename(fs.real(a), fs.real(b));
        await complete(b);
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (e) {
        this.ctx.log(`sftp rename ${a} -> ${b}: ${(e as Error).message}`);
        fail(reqid);
      }
    });
    // Close our side when the client ends the subsystem, so its exit doesn't wait forever.
    sftp.on('end', () => sftp.end());
    sftp.on('close', () => {
      for (const h of handles.values()) if (h.kind === 'file') void h.fh.close().catch(() => undefined);
      handles.clear();
    });
    for (const ev of ['SETSTAT', 'FSETSTAT'] as const) sftp.on(ev, (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
    for (const ev of ['MKDIR', 'RMDIR', 'READLINK', 'SYMLINK'] as const) sftp.on(ev, (reqid: number) => fail(reqid, STATUS_CODE.OP_UNSUPPORTED));
  }
}

function sftpCall<T>(fn: (cb: (err: Error | null | undefined, res?: any) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res as T))));
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

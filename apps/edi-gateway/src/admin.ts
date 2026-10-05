import Fastify, { type FastifyInstance } from 'fastify';
import { PROTOCOLS, type Db, type PartnerRow, type Protocol } from './db';
import type { Engine } from './engine';
import type { PayloadStore } from './store';
import type { Vault } from './vault';
import type { As2Adapter } from './protocols/as2/adapter';
import { certInfo, selfSigned } from './protocols/as2/cms';
import type { SftpAdapter } from './protocols/sftp/adapter';
import type { Oftp2Adapter } from './protocols/oftp2/adapter';
import type { JxAdapter } from './protocols/jx/adapter';
import { CIPHER_SUITES } from './protocols/oftp2/files';

/** Secret fields per protocol; values go to Vault, only "is set" flags come back. */
const SECRET_FIELDS: Record<string, string[]> = {
  sftp: ['password', 'privateKey', 'passphrase'],
  as2: ['password'],
  oftp2: ['sendPassword', 'receivePassword'],
  ebms: ['password'],
  jx: ['password'],
};

interface Deps {
  db: Db;
  vault: Vault;
  engine: Engine;
  store: PayloadStore;
  as2: As2Adapter;
  sftp: SftpAdapter;
  oftp2: Oftp2Adapter;
  jx: JxAdapter;
  sftpPort: number;
}

export function buildAdmin(d: Deps): FastifyInstance {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 50 * 1024 * 1024 });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.code === '23505') return reply.code(409).send({ error: 'A partner with this name already exists' });
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  const view = async (p: PartnerRow) => {
    const secret = (await d.vault.get(`partners/${p.id}`).catch(() => null)) ?? {};
    return { ...p, secrets: Object.fromEntries((SECRET_FIELDS[p.protocol] ?? []).map((k) => [k, Boolean(secret[k])])) };
  };

  const validate = (protocol: Protocol, config: Record<string, any>, name: string) => {
    const errs: string[] = [];
    if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(name ?? '')) errs.push('name must be 1-64 letters, digits, _ . -');
    errs.push(...d.engine.adapter(protocol).validate(config ?? {}));
    if (errs.length) throw Object.assign(new Error(errs.join('; ')), { statusCode: 400 });
  };

  const saveSecrets = async (p: PartnerRow, secrets?: Record<string, string>) => {
    if (!secrets) return;
    const allowed = SECRET_FIELDS[p.protocol] ?? [];
    const patch = Object.fromEntries(Object.entries(secrets).filter(([k]) => allowed.includes(k)));
    if (Object.keys(patch).length) await d.vault.merge(`partners/${p.id}`, patch);
  };

  app.get('/health', async () => ({ ok: true, protocols: d.engine.protocols() }));

  // ---- station ----------------------------------------------------------------
  app.get('/station', async () => {
    const as2 = await d.db.getStation('as2');
    const sec = await d.vault.get<{ certificate?: string }>('station/as2');
    return {
      as2: { ...as2, certificate: sec?.certificate ?? null, certInfo: sec?.certificate ? await certInfo(sec.certificate).catch(() => null) : null },
      sftp: { port: d.sftpPort, hostKeyFingerprint: await d.sftp.hostKeyFingerprint() },
      ebms: await d.db.getStation('ebms'),
      jx: await d.db.getStation('jx'),
      oftp2: await (async () => {
        const cfg = await d.db.getStation('oftp2');
        const sec = await d.vault.get<{ certificate?: string }>('station/oftp2');
        return {
          ...cfg, certificate: sec?.certificate ?? null, certInfo: sec?.certificate ? await certInfo(sec.certificate).catch(() => null) : null,
          cipherSuites: Object.fromEntries(Object.entries(CIPHER_SUITES).map(([k, v]) => [k, v.label])),
        };
      })(),
    };
  });

  app.put<{ Body: { jxId: string; domain?: string } }>('/station/jx', async (req) => {
    const { jxId, domain } = req.body ?? ({} as any);
    if (!jxId) throw Object.assign(new Error('jxId is required'), { statusCode: 400 });
    if (domain && !/^[A-Za-z0-9.-]+$/.test(domain)) throw Object.assign(new Error('domain must be a host name'), { statusCode: 400 });
    await d.db.setStation('jx', { jxId, domain: domain || undefined });
    return { ok: true };
  });

  app.put<{ Body: { partyId: string; partyIdType?: string } }>('/station/ebms', async (req) => {
    const { partyId, partyIdType } = req.body ?? ({} as any);
    if (!partyId) throw Object.assign(new Error('partyId is required'), { statusCode: 400 });
    await d.db.setStation('ebms', { partyId, partyIdType: partyIdType || undefined });
    return { ok: true };
  });

  app.put<{ Body: { odetteId: string } }>('/station/oftp2', async (req) => {
    const id = String(req.body?.odetteId ?? '').toUpperCase();
    if (!/^[A-Z0-9 /\-.&()]{1,25}$/.test(id)) throw Object.assign(new Error('odetteId: 1-25 of A-Z 0-9 / - . & ( )'), { statusCode: 400 });
    await d.db.setStation('oftp2', { ...(await d.db.getStation('oftp2')), odetteId: id });
    return { ok: true };
  });

  app.post<{ Body: { generate?: boolean; certificate?: string; privateKey?: string } }>('/station/oftp2/certificate', async (req) => {
    const st = await d.db.getStation('oftp2');
    if (req.body?.generate) {
      if (!st.odetteId) throw Object.assign(new Error('Set the ODETTE ID first'), { statusCode: 400 });
      await d.vault.merge('station/oftp2', await selfSigned(st.odetteId));
    } else {
      const { certificate, privateKey } = req.body ?? {};
      if (!certificate?.includes('BEGIN CERTIFICATE') || !privateKey?.includes('PRIVATE KEY')) {
        throw Object.assign(new Error('certificate and privateKey (PEM) are required'), { statusCode: 400 });
      }
      await d.vault.merge('station/oftp2', { certificate, privateKey });
    }
    await d.oftp2.reload(); // the TLS listener uses the station certificate
    return { ok: true };
  });

  app.put<{ Body: { as2Id: string; email?: string; publicUrl?: string } }>('/station/as2', async (req) => {
    const { as2Id, email, publicUrl } = req.body ?? ({} as any);
    if (!as2Id || as2Id.length > 128) throw Object.assign(new Error('as2Id is required'), { statusCode: 400 });
    await d.db.setStation('as2', { ...(await d.db.getStation('as2')), as2Id, email: email || undefined, publicUrl: publicUrl || undefined });
    return { ok: true };
  });

  /** Generates a self-signed certificate, or stores an uploaded certificate + key. */
  app.post<{ Body: { generate?: boolean; certificate?: string; privateKey?: string } }>('/station/as2/certificate', async (req) => {
    const st = await d.db.getStation('as2');
    if (req.body?.generate) {
      if (!st.as2Id) throw Object.assign(new Error('Set the AS2 ID first'), { statusCode: 400 });
      await d.vault.merge('station/as2', await selfSigned(st.as2Id));
    } else {
      const { certificate, privateKey } = req.body ?? {};
      if (!certificate?.includes('BEGIN CERTIFICATE') || !privateKey?.includes('PRIVATE KEY')) {
        throw Object.assign(new Error('certificate and privateKey (PEM) are required'), { statusCode: 400 });
      }
      await d.vault.merge('station/as2', { certificate, privateKey });
    }
    return { ok: true };
  });

  // ---- partners ---------------------------------------------------------------
  type PartnerBody = { name: string; protocol: Protocol; enabled?: boolean; config: Record<string, any>; inbound_flow?: string | null; secrets?: Record<string, string> };

  app.get('/partners', async () => Promise.all((await d.db.listPartners()).map(view)));

  app.get<{ Params: { id: string } }>('/partners/:id', async (req, reply) => {
    const p = await d.db.getPartner(req.params.id);
    return p ? view(p) : reply.code(404).send({ error: 'Partner not found' });
  });

  app.post<{ Body: PartnerBody }>('/partners', async (req, reply) => {
    const b = req.body;
    if (!PROTOCOLS.includes(b?.protocol)) throw Object.assign(new Error(`protocol must be one of ${PROTOCOLS.join(', ')}`), { statusCode: 400 });
    validate(b.protocol, b.config, b.name);
    const p = await d.db.createPartner({ name: b.name, protocol: b.protocol, enabled: b.enabled ?? true, config: b.config ?? {}, inbound_flow: b.inbound_flow || null });
    await saveSecrets(p, b.secrets);
    reply.code(201);
    return view(p);
  });

  app.put<{ Params: { id: string }; Body: PartnerBody }>('/partners/:id', async (req, reply) => {
    const cur = await d.db.getPartner(req.params.id);
    if (!cur) return reply.code(404).send({ error: 'Partner not found' });
    const b = req.body;
    validate(cur.protocol, b.config, b.name);
    const p = (await d.db.updatePartner(cur.id, { name: b.name, enabled: b.enabled ?? true, config: b.config ?? {}, inbound_flow: b.inbound_flow || null }))!;
    await saveSecrets(p, b.secrets);
    return view(p);
  });

  app.delete<{ Params: { id: string } }>('/partners/:id', async (req, reply) => {
    const p = await d.db.getPartner(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Partner not found' });
    await d.db.deletePartner(p.id);
    await d.vault.remove(`partners/${p.id}`);
    return reply.code(204).send();
  });

  /** Connectivity check (SFTP remote: connect + list; shows the host key to pin). */
  app.post<{ Params: { id: string } }>('/partners/:id/test', async (req, reply) => {
    const p = await d.db.getPartner(req.params.id);
    if (!p) return reply.code(404).send({ error: 'Partner not found' });
    if (p.protocol === 'sftp') return d.sftp.test(p);
    if (p.protocol === 'oftp2') {
      if ((p.config.mode ?? 'call') !== 'call') return { ok: false, error: 'Partner is in wait mode (it calls us)' };
      const r = await d.oftp2.call(p);
      return { ok: r.ok, error: r.error, received: r.received, sent: r.sent, responses: r.responses, trace: r.trace.join(' ') };
    }
    if (p.protocol === 'as2') {
      if (!p.config.url) return { ok: false, error: 'No URL configured' };
      try {
        const r = await fetch(p.config.url, { method: 'GET', signal: AbortSignal.timeout(10000) });
        return { ok: true, httpStatus: r.status };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    return { ok: false, error: 'not supported' };
  });

  app.post<{ Params: { id: string } }>('/partners/:id/poll', async (req, reply) => {
    const p = await d.db.getPartner(req.params.id);
    if (p?.protocol === 'jx' && p.config.mode === 'client') {
      try {
        const r = await d.jx.poll(p);
        return { ok: true, received: r.received, duplicates: r.duplicates };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    if (p?.protocol === 'oftp2' && (p.config.mode ?? 'call') === 'call') {
      const r = await d.oftp2.call(p);
      return r.ok ? { ok: true, received: r.received, sent: r.sent, responses: r.responses } : { ok: false, error: r.error };
    }
    if (!p || p.protocol !== 'sftp' || p.config.mode !== 'remote' || !p.config.pollDir) return reply.code(400).send({ error: 'Not a polling partner' });
    try {
      return { ok: true, received: await d.sftp.pollOne(p) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ---- messages ---------------------------------------------------------------
  app.get<{ Querystring: { partner?: string; direction?: string; limit?: string } }>('/messages', async (req) =>
    d.db.listMessages({ partner: req.query.partner, direction: req.query.direction, limit: Number(req.query.limit) || 100 }));

  app.get<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const m = await d.db.getMessage(req.params.id).catch(() => undefined);
    return m ?? reply.code(404).send({ error: 'Message not found' });
  });

  app.get<{ Params: { id: string } }>('/messages/:id/payload', async (req, reply) => {
    const m = await d.db.getMessage(req.params.id).catch(() => undefined);
    if (!m) return reply.code(404).send({ error: 'Message not found' });
    reply.header('Content-Type', m.content_type || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${(m.filename ?? 'payload').replace(/"/g, '')}"`);
    return reply.send(await d.store.get(m.id));
  });

  app.post<{ Params: { id: string } }>('/messages/:id/forward', async (req) => d.engine.forward(req.params.id));

  // ---- send (called by flows through the EDI Send node, and by the UI) ----------
  // Always 200: { ok: true, id, messageId, status, receipt } or { ok: false, error }.
  app.post<{ Body: { partner: string; filename?: string; contentType?: string; content: unknown; encoding?: 'utf8' | 'base64' } }>('/send', async (req) => {
    const b = req.body ?? ({} as any);
    if (!b.partner) return { ok: false, error: 'Request is missing "partner"' };
    if (b.content === undefined || b.content === null) return { ok: false, error: 'Request is missing "content"' };
    let content: Buffer;
    if (typeof b.content === 'string') content = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8');
    else content = Buffer.from(JSON.stringify(b.content));
    const contentType = b.contentType || (typeof b.content === 'string' ? 'application/octet-stream' : 'application/json');
    return d.engine.send(String(b.partner), { filename: b.filename, contentType, content });
  });

  return app;
}

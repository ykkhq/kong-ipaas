import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { Pools, validConnectionString } from '../src/connections';
import { VaultResolver } from '../src/vault';

const app = buildApp(new Pools(1000), { defaultMaxRows: 10 });
const query = (body: object) => app.inject({ method: 'POST', url: '/query', payload: body }).then((r) => ({ status: r.statusCode, body: r.json() }));

describe('POST /query validation', () => {
  it('requires a connection name or string', async () => {
    expect((await query({ sql: 'SELECT 1' })).body).toEqual({ ok: false, error: 'Request is missing "connection"' });
  });

  it('rejects non-postgres URLs', async () => {
    const r = await query({ connection: 'x', connectionString: 'mysql://u@h/d', sql: 'SELECT 1' });
    expect(r.body.error).toMatch(/not a valid postgres:\/\/ URL/);
  });

  it('reports missing variables before connecting', async () => {
    const r = await query({ connectionString: 'postgres://u:p@127.0.0.1:1/d', sql: 'SELECT :x' });
    expect(r.body).toEqual({ ok: false, error: 'Missing value for query variable :x' });
  });

  it('returns connection failures as ok:false', async () => {
    const r = await query({ connectionString: 'postgres://u:p@127.0.0.1:1/d', sql: 'SELECT 1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('ECONNREFUSED');
  });
});

describe('validConnectionString', () => {
  it.each([
    ['postgres://u:p@h:5432/d', true],
    ['postgresql://h/d', true],
    ['http://h', false],
    ['not a url', false],
    [42, false],
  ])('%s -> %s', (s, ok) => expect(validConnectionString(s)).toBe(ok));
});

describe('Vault resolution', () => {
  const store: Record<string, string> = { crm: 'postgres://u:p@127.0.0.1:1/crm' };
  let reads = 0;
  const fetchImpl = (async (url: any, init: any) => {
    reads++;
    expect(init.headers['X-Vault-Token']).toBe('tok');
    const name = decodeURIComponent(String(url).split('/db/')[1]);
    return store[name] ? new Response(JSON.stringify({ data: { data: { connectionString: store[name] } } })) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  const vault = new VaultResolver('http://vault:8200', () => 'tok', 'ipaas', 60000, fetchImpl);
  const vapp = buildApp(new Pools(1000), { defaultMaxRows: 10, vault });
  const vq = (body: object) => vapp.inject({ method: 'POST', url: '/query', payload: body }).then((r) => r.json());

  it('resolves a stored connection by name', async () => {
    const r = await vq({ connection: 'crm', sql: 'SELECT 1' });
    expect(r.code).toBe('ECONNREFUSED'); // resolved and tried to connect
  });

  it('reports unknown connections', async () => {
    expect(await vq({ connection: 'nope', sql: 'SELECT 1' })).toEqual({ ok: false, error: 'Unknown connection "nope"' });
  });

  it('caches lookups until invalidated', async () => {
    reads = 0;
    await vault.connectionString('crm');
    await vault.connectionString('crm');
    expect(reads).toBe(0); // cached from the first test
    await vapp.inject({ method: 'POST', url: '/invalidate', payload: { connection: 'crm' } });
    store.crm = 'postgres://u:p2@127.0.0.1:1/crm';
    expect(await vault.connectionString('crm')).toBe('postgres://u:p2@127.0.0.1:1/crm');
    expect(reads).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { Pools, validConnectionString } from '../src/connections';

const app = buildApp(new Pools(1000), { defaultMaxRows: 10 });
const query = (body: object) => app.inject({ method: 'POST', url: '/query', payload: body }).then((r) => ({ status: r.statusCode, body: r.json() }));

describe('POST /query validation', () => {
  it('reports a missing vault value with the connection name', async () => {
    expect(await query({ connection: 'crm', connectionString: '', sql: 'SELECT 1' }))
      .toEqual({ status: 200, body: { ok: false, error: 'No connection string for "crm"; does the vault entry exist?' } });
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

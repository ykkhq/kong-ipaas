import { describe, expect, it, vi } from 'vitest';
import { exampleFlows } from '@ipaas/flow-core';
import { ConnectionService, connectionsUsedBy, describeConnectionString, systemRouteConfig } from '../src/connections';
import type { ConnectionRow, Db, FlowRow } from '../src/db';
import type { DbAccessManager } from '../src/dbaccess';
import type { Gateway } from '../src/gateway';
import type { Konnect } from '../src/konnect';

function setup(opts: { testOk?: boolean; flows?: Partial<FlowRow>[] } = {}) {
  const conns = new Map<string, ConnectionRow>();
  const secrets = new Map<string, string>();
  const upserts: string[] = [];
  const db = {
    getConnection: async (n: string) => conns.get(n),
    listConnections: async () => [...conns.values()],
    upsertConnection: async (c: any) => { conns.set(c.name, { ...c, test_ok: null }); return conns.get(c.name)!; },
    setConnectionDescription: async (n: string, d: string) => { conns.get(n)!.description = d; return conns.get(n); },
    recordConnectionTest: async (n: string, ok: boolean) => { conns.get(n)!.test_ok = ok; },
    deleteConnection: async (n: string) => { conns.delete(n); },
    initSetting: async (_k: string, v: string) => v,
    list: async () => (opts.flows ?? []) as FlowRow[],
  } as unknown as Db;
  const konnect = {
    findOrCreateConfigStore: async () => 'store-1',
    upsert: async (kind: string, _id: string, body: any) => { upserts.push(`${kind}:${body.name}`); return body; },
    putSecret: async (_s: string, k: string, v: string) => { secrets.set(k, v); },
    deleteSecret: async (_s: string, k: string) => { secrets.delete(k); },
  } as unknown as Konnect;
  const dbAccess = {
    call: vi.fn(async () => (opts.testOk === false ? { ok: false, error: 'password authentication failed' } : { ok: true, rows: [{ ok: 1 }] })),
    ensure: async () => ({ state: 'running' }),
  } as unknown as DbAccessManager;
  const svc = new ConnectionService(db, konnect, {} as Gateway, dbAccess, { storeName: 's', vaultPrefix: 'ipaasdb', dbAccessUrl: 'http://db-access:4020' }, () => undefined);
  return { svc, conns, secrets, upserts, dbAccess };
}

const URL1 = 'postgres://app:s3cret@crm.internal:6543/crm';

describe('ConnectionService', () => {
  it('tests, stores the string only in the vault, and keeps non-secret details locally', async () => {
    const { svc, conns, secrets, upserts } = setup();
    const row = await svc.save({ name: 'crm', connectionString: URL1, description: 'CRM' }, 'create');
    expect(secrets.get('crm')).toBe(URL1);
    expect(row).toMatchObject({ name: 'crm', host: 'crm.internal', port: 6543, database: 'crm', username: 'app', description: 'CRM' });
    expect(JSON.stringify([...conns.values()])).not.toContain('s3cret');
    expect(upserts).toContain('vaults:konnect');
    expect(upserts).toContain('plugins:datakit');
    expect(secrets.has('ipaas_internal_token')).toBe(true);
  });

  it('refuses to store a string that fails the connection test', async () => {
    const { svc, secrets } = setup({ testOk: false });
    await expect(svc.save({ name: 'crm', connectionString: URL1 }, 'create')).rejects.toThrow(/Connection test failed: password authentication failed/);
    expect(secrets.has('crm')).toBe(false);
  });

  it('rotates an existing string in place', async () => {
    const { svc, secrets } = setup();
    await svc.save({ name: 'crm', connectionString: URL1 }, 'create');
    await svc.save({ name: 'crm', connectionString: 'postgres://app:new@crm.internal:6543/crm' }, 'update');
    expect(secrets.get('crm')).toBe('postgres://app:new@crm.internal:6543/crm');
  });

  it.each([
    ['Bad-Name', /Name must be/],
    ['ipaas_x', /Name must be/],
  ])('rejects name %s', async (name, msg) => {
    await expect(setup().svc.save({ name, connectionString: URL1 }, 'create')).rejects.toThrow(msg);
  });

  it('will not delete a connection that flows use', async () => {
    const flow = exampleFlows().find((f) => f.slug === 'customer-db')!;
    const { svc } = setup({ flows: [{ id: 'f1', name: flow.name, graph: flow.graph }] });
    await svc.save({ name: 'sample', connectionString: URL1 }, 'create');
    await expect(svc.remove('sample')).rejects.toThrow(/used by: Customer from Database/);
  });

  it('seeds DB_CONN_* once without testing', async () => {
    const { svc, dbAccess } = setup();
    expect(await svc.seedFromEnv({ DB_CONN_SAMPLE: URL1, OTHER: 'x' })).toEqual(['sample']);
    expect(await svc.seedFromEnv({ DB_CONN_SAMPLE: URL1 })).toEqual([]);
    expect(dbAccess.call).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('parses connection strings without keeping the password', () => {
    expect(describeConnectionString(URL1)).toEqual({ host: 'crm.internal', port: 6543, database: 'crm', username: 'app' });
    expect(() => describeConnectionString('mysql://h/d')).toThrow(/Only postgres/);
  });

  it('lists connections used by a graph', () => {
    expect(connectionsUsedBy(exampleFlows().find((f) => f.slug === 'customer-db')!.graph)).toEqual(['sample']);
  });

  it('builds a token-guarded system route with one vault entry per connection', () => {
    const c = systemRouteConfig(['sample', 'crm'], 'ipaasdb', 'http://db-access:4020/');
    expect(c.resources!.vault).toEqual({
      token: '{vault://ipaasdb/ipaas_internal_token}', db_sample: '{vault://ipaasdb/sample}', db_crm: '{vault://ipaasdb/crm}',
    });
    expect(c.nodes.find((n) => n.name === 'REQ')!.inputs).toEqual({ b: 'request.body', db_sample: 'vault.db_sample', db_crm: 'vault.db_crm' });
    expect(c.nodes.find((n) => n.name === 'AUTH_GATE')).toMatchObject({ then: ['REQ', 'CALL', 'OUT'], else: ['DENY_BODY', 'DENY'] });
    expect(c.nodes.find((n) => n.name === 'CALL')!.url).toBe('http://db-access:4020/query');
  });
});

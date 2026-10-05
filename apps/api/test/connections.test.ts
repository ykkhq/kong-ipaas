import { describe, expect, it, vi } from 'vitest';
import { exampleFlows } from '@ipaas/flow-core';
import { ConnectionService, connectionsUsedBy, describeConnectionString } from '../src/connections';
import type { ConnectionRow, Db, FlowRow } from '../src/db';
import type { DbAccessManager } from '../src/dbaccess';
import type { VaultClient } from '../src/vault';

function setup(opts: { testOk?: boolean; flows?: Partial<FlowRow>[]; running?: boolean } = {}) {
  const conns = new Map<string, ConnectionRow>();
  const secrets = new Map<string, { connectionString: string; description?: string }>();
  const db = {
    getConnection: async (n: string) => conns.get(n),
    listConnections: async () => [...conns.values()],
    upsertConnection: async (c: any) => { conns.set(c.name, { ...c, test_ok: null }); return conns.get(c.name)!; },
    setConnectionDescription: async (n: string, d: string) => { conns.get(n)!.description = d; return conns.get(n); },
    recordConnectionTest: async (n: string, ok: boolean) => { conns.get(n)!.test_ok = ok; },
    deleteConnection: async (n: string) => { conns.delete(n); },
    list: async () => (opts.flows ?? []) as FlowRow[],
  } as unknown as Db;
  const vault = {
    put: async (k: string, v: any) => { secrets.set(k, v); },
    get: async (k: string) => secrets.get(k) ?? null,
    remove: async (k: string) => { secrets.delete(k); },
    list: async () => [...secrets.keys()],
  } as unknown as VaultClient;
  const call = vi.fn(async (_m: string, path: string) => {
    if (path === '/invalidate') return { ok: true };
    return opts.testOk === false ? { ok: false, error: 'password authentication failed' } : { ok: true, rows: [{ ok: 1 }] };
  });
  const dbAccess = { call, status: () => ({ state: opts.running === false ? 'absent' : 'running' }) } as unknown as DbAccessManager;
  const svc = new ConnectionService(db, vault, dbAccess, () => undefined);
  return { svc, conns, secrets, call };
}

const URL1 = 'postgres://app:s3cret@crm.internal:6543/crm';

describe('ConnectionService (local Vault)', () => {
  it('tests, stores the string only in Vault, and keeps non-secret details locally', async () => {
    const { svc, conns, secrets, call } = setup();
    const row = await svc.save({ name: 'crm', connectionString: URL1, description: 'CRM' }, 'create');
    expect(secrets.get('crm')).toEqual({ connectionString: URL1, description: 'CRM' });
    expect(row).toMatchObject({ name: 'crm', host: 'crm.internal', port: 6543, database: 'crm', username: 'app' });
    expect(JSON.stringify([...conns.values()])).not.toContain('s3cret');
    expect(call).toHaveBeenCalledWith('POST', '/query', { connectionString: URL1, sql: 'SELECT 1 AS ok' });
  });

  it('refuses to store a string that fails the connection test', async () => {
    const { svc, secrets } = setup({ testOk: false });
    await expect(svc.save({ name: 'crm', connectionString: URL1 }, 'create')).rejects.toThrow(/Connection test failed: password authentication failed/);
    expect(secrets.has('crm')).toBe(false);
  });

  it('rotates in place and invalidates the db-access cache', async () => {
    const { svc, secrets, call } = setup();
    await svc.save({ name: 'crm', connectionString: URL1 }, 'create');
    await svc.save({ name: 'crm', connectionString: 'postgres://app:new@crm.internal:6543/crm' }, 'update');
    expect(secrets.get('crm')!.connectionString).toBe('postgres://app:new@crm.internal:6543/crm');
    expect(call).toHaveBeenCalledWith('POST', '/invalidate', { connection: 'crm' });
  });

  it('runs stored-connection queries by name only', async () => {
    const { svc, call } = setup();
    await svc.save({ name: 'crm', connectionString: URL1 }, 'create');
    await svc.query({ connection: 'crm', sql: 'SELECT :x', params: { x: 1 } });
    expect(call).toHaveBeenLastCalledWith('POST', '/query', { maxRows: 50, connection: 'crm', sql: 'SELECT :x', params: { x: 1 } });
  });

  it('rejects invalid names', async () => {
    await expect(setup().svc.save({ name: 'Bad-Name', connectionString: URL1 }, 'create')).rejects.toThrow(/Name must be/);
  });

  it('will not delete a connection that flows use', async () => {
    const flow = exampleFlows().find((f) => f.slug === 'customer-db')!;
    const { svc } = setup({ flows: [{ id: 'f1', name: flow.name, graph: flow.graph }] });
    await svc.save({ name: 'sample', connectionString: URL1 }, 'create');
    await expect(svc.remove('sample')).rejects.toThrow(/used by: Customer from Database/);
  });

  it('seeds DB_CONN_* only when missing from Vault, without testing', async () => {
    const { svc, call, secrets } = setup();
    expect(await svc.seedFromEnv({ DB_CONN_SAMPLE: URL1, OTHER: 'x' })).toEqual(['sample']);
    expect(await svc.seedFromEnv({ DB_CONN_SAMPLE: 'postgres://other@h/d' })).toEqual([]);
    expect(secrets.get('sample')!.connectionString).toBe(URL1);
    expect(call).not.toHaveBeenCalled();
  });

  it('flags connections missing from Vault', async () => {
    const { svc, secrets } = setup();
    await svc.save({ name: 'crm', connectionString: URL1 }, 'create');
    secrets.delete('crm');
    expect((await svc.list())[0]).toMatchObject({ name: 'crm', in_vault: false });
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
});

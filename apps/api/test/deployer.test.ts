import { describe, expect, it, vi } from 'vitest';
import { exampleFlows } from '@ipaas/flow-core';
import type { Db, FlowRow } from '../src/db';
import { Deployer, entityIds } from '../src/deployer';
import type { Gateway } from '../src/gateway';
import { Konnect } from '../src/konnect';

const CP = '11111111-2222-3333-4444-555555555555';

function fakeKonnect() {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes('/control-planes?')) return new Response(JSON.stringify({ data: [{ id: CP }] }));
    if (init.method === 'DELETE') return new Response(null, { status: 404 });
    return new Response(init.body ?? '{}');
  }) as unknown as typeof fetch;
  return { konnect: new Konnect('kpat_test', 'eu', 'ipaas-local', fetchImpl), calls };
}

function fakeDb(row: FlowRow) {
  return {
    setStatus: vi.fn(async (_id: string, status: string, extra: any = {}) => Object.assign(row, { status }, extra)),
  } as unknown as Db;
}

const gateway = { status: async () => ({ ready: true, configHash: 'a' }), waitForSync: async () => true } as unknown as Gateway;

const row = (): FlowRow => {
  const f = exampleFlows()[0];
  return { id: '0c6f2c8e-5f6e-4a8a-9e57-6a1f5d2c9b11', name: f.name, slug: f.slug, debug: true, graph: f.graph, version: 3, status: 'draft',
    deployed_version: null, deployed_at: null, last_error: null, created_at: '', updated_at: '' };
};

describe('Deployer', () => {
  it('upserts service, route and datakit plugin with stable ids', async () => {
    const { konnect, calls } = fakeKonnect();
    const r = row();
    const res = await new Deployer(fakeDb(r), konnect, gateway, 1000).deploy(r);
    expect(res.row.status).toBe('live');
    expect(res.row.deployed_version).toBe(3);

    const ids = entityIds(r.id);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual([
      `https://eu.api.konghq.com/v2/control-planes/${CP}/core-entities/services/${ids.service}`,
      `https://eu.api.konghq.com/v2/control-planes/${CP}/core-entities/routes/${ids.route}`,
      `https://eu.api.konghq.com/v2/control-planes/${CP}/core-entities/plugins/${ids.plugin}`,
    ]);
    expect(puts[1].body).toMatchObject({ paths: ['/flows/customer-360'], methods: ['GET'], service: { id: ids.service } });
    expect(puts[2].body).toMatchObject({ name: 'datakit', route: { id: ids.route } });
    expect(puts[2].body.config.nodes.length).toBeGreaterThan(5);
    expect(entityIds(r.id)).toEqual(ids);
  });

  it('records Konnect errors on the flow', async () => {
    const fetchImpl = (async (url: any) =>
      String(url).includes('/control-planes?')
        ? new Response(JSON.stringify({ data: [{ id: CP }] }))
        : new Response(JSON.stringify({ message: 'schema violation', fields: { config: 'bad' } }), { status: 400 })) as typeof fetch;
    const r = row();
    const res = await new Deployer(fakeDb(r), new Konnect('kpat', 'us', 'cp', fetchImpl), gateway, 1000).deploy(r);
    expect(res.row.status).toBe('error');
    expect(res.row.last_error).toMatch(/400: schema violation/);
  });

  it('refuses to deploy an invalid graph', async () => {
    const { konnect, calls } = fakeKonnect();
    const r = row();
    r.graph = { nodes: r.graph.nodes.filter((n) => n.type !== 'response'), edges: [] };
    const res = await new Deployer(fakeDb(r), konnect, gateway, 1000).deploy(r);
    expect(res.row.status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('undeploys children first and tolerates missing entities', async () => {
    const { konnect, calls } = fakeKonnect();
    const r = row();
    await new Deployer(fakeDb(r), konnect, gateway, 1000).undeploy(r);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/core-entities/')[1].split('/')[0])).toEqual(['plugins', 'routes', 'services']);
  });
});

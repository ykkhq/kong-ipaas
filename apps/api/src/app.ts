import Fastify, { type FastifyInstance } from 'fastify';
import { SLUG_RE, exampleFlows, summarizeTrace, type FlowGraph, type TraceSummary } from '@ipaas/flow-core';
import { stringify } from 'yaml';
import type { Db, FlowRow } from './db';
import { compileRow, type Deployer } from './deployer';
import type { Gateway } from './gateway';
import type { Konnect } from './konnect';

export interface Deps {
  db: Db;
  konnect: Konnect;
  gateway: Gateway;
  deployer: Deployer;
  publicGatewayUrl: string;
}

interface FlowBody { name: string; slug: string; debug?: boolean; graph: FlowGraph }

const flowSchema = {
  type: 'object',
  required: ['name', 'slug', 'graph'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    slug: { type: 'string', pattern: SLUG_RE.source, maxLength: 80 },
    debug: { type: 'boolean' },
    graph: {
      type: 'object',
      required: ['nodes', 'edges'],
      properties: { nodes: { type: 'array' }, edges: { type: 'array' } },
    },
  },
} as const;

export function buildApp(deps: Deps): FastifyInstance {
  const { db, konnect, gateway, deployer } = deps;
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  const view = (row: FlowRow) => ({
    ...row,
    endpoint: `${deps.publicGatewayUrl}/flows/${row.slug}`,
  });

  const load = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return db.get(id);
  };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.code === '23505') return reply.code(409).send({ error: 'A flow with this slug already exists' });
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/status', async () => {
    const dp = await gateway.status();
    let cp: { id?: string; error?: string; nodes?: unknown[] } = {};
    if (!konnect.configured) cp.error = 'KONNECT_PAT is not set';
    else {
      try {
        cp = { id: await konnect.cpId(), nodes: await konnect.nodes() };
      } catch (e) {
        cp.error = (e as Error).message;
      }
    }
    return { dataPlane: dp, controlPlane: cp, gatewayUrl: deps.publicGatewayUrl };
  });

  app.get('/api/flows', async () => (await db.list()).map(view));

  app.post<{ Body: FlowBody }>('/api/flows', { schema: { body: flowSchema } }, async (req, reply) => {
    reply.code(201);
    return view(await db.create(req.body));
  });

  app.get<{ Params: { id: string } }>('/api/flows/:id', async (req, reply) => {
    const row = await load(req.params.id);
    return row ? view(row) : reply.code(404).send({ error: 'Flow not found' });
  });

  app.put<{ Params: { id: string }; Body: FlowBody }>('/api/flows/:id', { schema: { body: flowSchema } }, async (req, reply) => {
    const existing = await load(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'Flow not found' });
    if (existing.deployed_version && existing.slug !== req.body.slug) {
      return reply.code(409).send({ error: 'Undeploy the flow before changing its slug' });
    }
    return view((await db.update(existing.id, req.body))!);
  });

  app.delete<{ Params: { id: string } }>('/api/flows/:id', async (req, reply) => {
    const row = await load(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Flow not found' });
    if (row.deployed_version) await deployer.undeploy(row);
    await db.remove(row.id);
    return reply.code(204).send();
  });

  /** Compiles a graph without saving (live preview while editing). */
  app.post<{ Body: FlowBody }>('/api/compile', { schema: { body: flowSchema } }, async (req) => {
    const r = compileRow({ ...req.body, debug: req.body.debug ?? true });
    return { ...r, yaml: r.config ? stringify({ name: 'datakit', config: r.config }) : null };
  });

  app.post<{ Params: { id: string } }>('/api/flows/:id/deploy', async (req, reply) => {
    const row = await load(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Flow not found' });
    const { row: updated, compiled, synced } = await deployer.deploy(row);
    if (updated.status === 'error') return reply.code(compiled.ok ? 502 : 400).send({ error: updated.last_error, errors: compiled.errors, flow: view(updated) });
    return { flow: view(updated), synced };
  });

  app.post<{ Params: { id: string } }>('/api/flows/:id/undeploy', async (req, reply) => {
    const row = await load(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Flow not found' });
    return { flow: view(await deployer.undeploy(row)) };
  });

  /** Invokes the deployed flow through the local DP and returns result + trace. */
  app.post<{
    Params: { id: string };
    Body: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; trace?: boolean };
  }>('/api/flows/:id/test', async (req, reply) => {
    const row = await load(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Flow not found' });
    const compiled = compileRow(row);
    const trigger = row.graph.nodes.find((n) => n.type === 'trigger');
    const method = trigger?.type === 'trigger' ? trigger.data.method : 'GET';
    const trace = (req.body?.trace ?? true) && row.debug;
    const res = await gateway.invoke(`/flows/${row.slug}`, { method, ...req.body, trace });
    const isTrace = trace && typeof res.body === 'object' && res.body !== null && 'events' in res.body;
    const summary = isTrace ? summarizeTrace(res.body as any, compiled.nodeMap) : undefined;
    return {
      request: { method, url: res.url },
      status: res.status,
      latencyMs: res.latencyMs,
      headers: res.headers,
      body: summary ? (summary.exit?.body ?? traceFailure(summary)) : res.body,
      trace: summary,
    };
  });

  /** Recreates the bundled example flows that are missing (by slug). */
  app.post<{ Body: { mocksUrl?: string } }>('/api/examples', async (req) => {
    return seedExamples(db, (req.body as any)?.mocksUrl);
  });

  return app;
}

/** Trace mode replaces the HTTP body; when no exit ran, report the failing node instead. */
function traceFailure(summary: TraceSummary) {
  const failed = summary.nodes.find((n) => n.state === 'fail');
  return failed ? { error: 'node execution error', node: failed.name, type: failed.type, detail: failed.error } : null;
}

export async function seedExamples(db: Db, mocksUrl?: string): Promise<FlowRow[]> {
  const existing = new Set((await db.list()).map((f) => f.slug));
  const created: FlowRow[] = [];
  for (const f of exampleFlows(mocksUrl)) {
    if (!existing.has(f.slug)) created.push(await db.create(f));
  }
  return created;
}

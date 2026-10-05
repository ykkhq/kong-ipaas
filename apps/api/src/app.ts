import Fastify, { type FastifyInstance } from 'fastify';
import { SLUG_RE, exampleFlows, summarizeTrace, type FlowGraph, type TraceSummary } from '@ipaas/flow-core';
import { stringify } from 'yaml';
import type { Db, FlowRow } from './db';
import { ConnectionError, type ConnectionService } from './connections';
import { usesDatabase, type DbAccessManager } from './dbaccess';
import type { Deployer } from './deployer';
import type { Gateway } from './gateway';
import type { Konnect } from './konnect';

export interface Deps {
  db: Db;
  konnect: Konnect;
  gateway: Gateway;
  deployer: Deployer;
  dbAccess: DbAccessManager;
  connections: ConnectionService;
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
  const { db, konnect, gateway, deployer, dbAccess, connections } = deps;

  /** "When a Database node is configured": bring db-access up in the background. */
  const ensureDbAccessFor = (graph: FlowGraph) => {
    if (!usesDatabase(graph)) return;
    dbAccess.ensure().then((s) => s.state === 'error' && app.log.error(`db-access: ${s.error}`));
  };
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
    if (err instanceof ConnectionError) return reply.code(err.status).send({ error: err.message });
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
    const row = await db.create(req.body);
    ensureDbAccessFor(row.graph);
    return view(row);
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
    const row = (await db.update(existing.id, req.body))!;
    ensureDbAccessFor(row.graph);
    return view(row);
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
    const r = deployer.compile({ ...req.body, debug: req.body.debug ?? true });
    ensureDbAccessFor(req.body.graph);
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
    const compiled = deployer.compile(row);
    const trigger = row.graph.nodes.find((n) => n.type === 'trigger');
    const method = trigger?.type === 'trigger' ? trigger.data.method : 'GET';
    const trace = (req.body?.trace ?? true) && row.debug;
    const res = await gateway.invoke(`/flows/${row.slug}`, { method, ...req.body, trace });
    const isTrace = trace && typeof res.body === 'object' && res.body !== null && 'events' in res.body;
    const summary = isTrace ? summarizeTrace(res.body as any, compiled.nodeMap, compiled.failPaths) : undefined;
    // Trace mode answers 200 with the trace; report the status the flow would have returned.
    const exitNode = summary?.exit && compiled.config?.nodes.find((n) => n.name === summary.exit!.name);
    const status = exitNode ? Number(exitNode.status ?? 200) : summary && summary.status !== 'PLAN_COMPLETE' ? 500 : res.status;
    return {
      request: { method, url: res.url },
      status,
      latencyMs: res.latencyMs,
      headers: res.headers,
      body: summary ? (summary.exit?.body ?? traceFailure(summary)) : res.body,
      trace: summary,
    };
  });

  // ---- database access ------------------------------------------------------
  app.get('/api/db/status', async () => dbAccess.status());

  /** Runs SQL with a stored connection (db-access resolves it from Vault), for the inspector's "Run query". */
  app.post<{ Body: { connection: string; sql: string; params?: Record<string, unknown>; maxRows?: number } }>('/api/db/query', async (req, reply) => {
    try {
      return await connections.query(req.body);
    } catch (e) {
      if (e instanceof ConnectionError) throw e;
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  // ---- connections (strings stored in the local Vault) ---------------------------
  const connBody = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      connectionString: { type: 'string', maxLength: 2000 },
      description: { type: 'string', maxLength: 500 },
      skipTest: { type: 'boolean' },
    },
  } as const;
  type ConnBody = { name: string; connectionString?: string; description?: string; skipTest?: boolean };

  app.get('/api/connections', async () => connections.list());

  app.post<{ Body: ConnBody }>('/api/connections', { schema: { body: { ...connBody, required: ['name', 'connectionString'] } } }, async (req, reply) => {
    reply.code(201);
    return connections.save(req.body, 'create');
  });

  /** Rotates the stored string (applies to the next query of every flow) and/or edits the description. */
  app.put<{ Params: { name: string }; Body: ConnBody }>('/api/connections/:name', { schema: { body: connBody } }, async (req) =>
    connections.save({ ...req.body, name: req.params.name }, 'update'));

  app.delete<{ Params: { name: string } }>('/api/connections/:name', async (req, reply) => {
    await connections.remove(req.params.name);
    return reply.code(204).send();
  });

  /** Tests a connection string before saving it. Nothing is stored. */
  app.post<{ Body: { connectionString: string } }>('/api/connections/test', { schema: { body: { type: 'object', required: ['connectionString'], properties: { connectionString: { type: 'string' } } } } }, async (req) =>
    connections.testString(req.body.connectionString));

  /** Tests a stored connection the way flows use it (resolved from Vault by db-access). */
  app.post<{ Params: { name: string } }>('/api/connections/:name/test', async (req) => connections.testStored(req.params.name));

  /** Recreates the bundled example flows that are missing (by slug). */
  app.post<{ Body: { mocksUrl?: string } }>('/api/examples', async (req) => {
    const created = await seedExamples(db, (req.body as any)?.mocksUrl);
    for (const f of created) ensureDbAccessFor(f.graph);
    return created;
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

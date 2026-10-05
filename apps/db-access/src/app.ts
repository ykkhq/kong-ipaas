import Fastify, { type FastifyInstance } from 'fastify';
import { validConnectionString, type Pools } from './connections';
import { ParamError, bindNamed } from './params';

export interface QueryRequest {
  /** Resolved by the data plane from {vault://…}; never logged. */
  connectionString: string;
  /** Connection name, only used in error messages. */
  connection?: string;
  sql: string;
  params?: Record<string, unknown>;
  maxRows?: number;
}

export type QueryResult =
  | { ok: true; rows: unknown[]; rowCount: number; fields: string[]; truncated: boolean; durationMs: number }
  | { ok: false; error: string; code?: string; detail?: string; hint?: string; position?: string };

const MAX_ROWS = 10000;

/**
 * Query errors are reported as HTTP 200 with `ok: false` so a DataKit flow can
 * branch on them and return the database message to its caller.
 */
export function buildApp(pools: Pools, opts: { defaultMaxRows: number }): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

  app.get('/health', async () => ({ ok: true, pools: pools.size }));

  app.post<{ Body: QueryRequest }>('/query', async (req): Promise<QueryResult> => {
    const body = req.body ?? ({} as QueryRequest);
    const label = typeof body.connection === 'string' && body.connection ? `"${body.connection}"` : 'the connection';
    if (!body.connectionString) return { ok: false, error: `No connection string for ${label}; does the vault entry exist?` };
    if (!validConnectionString(body.connectionString)) return { ok: false, error: `Connection string for ${label} is not a valid postgres:// URL` };
    if (typeof body.sql !== 'string' || !body.sql.trim()) return { ok: false, error: 'Request is missing "sql"' };
    if (body.params != null && (typeof body.params !== 'object' || Array.isArray(body.params))) return { ok: false, error: '"params" must be an object' };

    const pool = pools.get(body.connectionString);

    let bound;
    try {
      bound = bindNamed(body.sql, body.params ?? {});
    } catch (e) {
      if (e instanceof ParamError) return { ok: false, error: e.message };
      throw e;
    }

    const limit = Math.min(Math.max(1, Number(body.maxRows) || opts.defaultMaxRows), MAX_ROWS);
    const started = performance.now();
    try {
      const r = await pool.query({ text: bound.text, values: bound.values });
      // Multi-statement SQL returns an array of results; report the last one.
      const res = Array.isArray(r) ? r[r.length - 1] : r;
      const rows = res.rows ?? [];
      return {
        ok: true,
        rows: rows.slice(0, limit),
        rowCount: res.rowCount ?? rows.length,
        fields: (res.fields ?? []).map((f: { name: string }) => f.name),
        truncated: rows.length > limit,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (e: any) {
      req.log.warn({ code: e.code, err: e.message }, 'query failed');
      return { ok: false, error: e.message, code: e.code, detail: e.detail, hint: e.hint, position: e.position };
    }
  });

  return app;
}

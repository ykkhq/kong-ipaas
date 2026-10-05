import Fastify, { type FastifyInstance } from 'fastify';
import { validConnectionString, type Pools } from './connections';
import { ParamError, bindNamed } from './params';
import { ResolveError, type VaultResolver } from './vault';

export interface QueryRequest {
  /** Name of a connection stored in Vault (what flows send). */
  connection?: string;
  /** Explicit string, used only by the API to test a connection before saving it. Never logged. */
  connectionString?: string;
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
export function buildApp(pools: Pools, opts: { defaultMaxRows: number; vault?: VaultResolver }): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

  app.get('/health', async () => ({ ok: true, pools: pools.size }));

  /** Called by the API after a connection is rotated or deleted. */
  app.post<{ Body: { connection?: string } }>('/invalidate', async (req) => {
    for (const old of opts.vault?.invalidate(req.body?.connection) ?? []) pools.drop(old);
    return { ok: true };
  });

  app.post<{ Body: QueryRequest }>('/query', async (req): Promise<QueryResult> => {
    const body = req.body ?? ({} as QueryRequest);
    let connectionString = body.connectionString;
    const label = body.connection ? `"${body.connection}"` : 'the connection';
    if (!connectionString) {
      if (typeof body.connection !== 'string' || !body.connection) return { ok: false, error: 'Request is missing "connection"' };
      if (!opts.vault) return { ok: false, error: 'Vault is not configured on db-access' };
      try {
        connectionString = await opts.vault.connectionString(body.connection);
      } catch (e) {
        if (e instanceof ResolveError) return { ok: false, error: e.message };
        return { ok: false, error: `Vault unavailable: ${(e as Error).message}` };
      }
    }
    if (!validConnectionString(connectionString)) return { ok: false, error: `Connection string for ${label} is not a valid postgres:// URL` };
    if (typeof body.sql !== 'string' || !body.sql.trim()) return { ok: false, error: 'Request is missing "sql"' };
    if (body.params != null && (typeof body.params !== 'object' || Array.isArray(body.params))) return { ok: false, error: '"params" must be an object' };

    const pool = pools.get(connectionString);

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

import type { FlowGraph } from '@ipaas/flow-core';
import type { ConnectionRow, Db } from './db';
import type { DbAccessManager } from './dbaccess';
import type { VaultClient } from './vault';

export const CONNECTION_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

export class ConnectionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type QueryResult =
  | { ok: true; rows: unknown[]; rowCount: number; fields: string[]; truncated: boolean; durationMs: number }
  | { ok: false; error: string; code?: string; detail?: string; hint?: string };

/** Parses a postgres URL into the non-secret details we keep locally. */
export function describeConnectionString(s: string): Pick<ConnectionRow, 'host' | 'port' | 'database' | 'username'> {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ConnectionError(400, 'Connection string must be a URL like postgres://user:password@host:5432/database');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new ConnectionError(400, 'Only postgres:// connection strings are supported');
  if (!u.hostname) throw new ConnectionError(400, 'Connection string has no host');
  return { host: u.hostname, port: Number(u.port || 5432), database: decodeURIComponent(u.pathname.slice(1)) || 'postgres', username: decodeURIComponent(u.username) };
}

export const connectionsUsedBy = (graph: FlowGraph): string[] =>
  [...new Set(graph.nodes.flatMap((n) => (n.type === 'database' && n.data.connection ? [n.data.connection] : [])))];

/**
 * Database connection strings live in the local Vault (KV v2, ipaas/db/<name>).
 * Flows carry only the connection name; db-access resolves it from Vault with a
 * read-only token. Postgres keeps non-secret details for listing.
 */
export class ConnectionService {
  constructor(
    private db: Db,
    private vault: VaultClient,
    private dbAccess: DbAccessManager,
    private log: (msg: string) => void = console.log,
  ) {}

  /** Waits for Vault to be unsealed and reachable. */
  async ready(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await this.vault.ready())) {
      if (Date.now() > deadline) throw new ConnectionError(503, 'Vault is not ready');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async list(): Promise<(ConnectionRow & { in_vault: boolean; used_by: { id: string; name: string }[] })[]> {
    const [conns, flows, keys] = await Promise.all([this.db.listConnections(), this.db.list(), this.vault.list().catch(() => null)]);
    return conns.map((c) => ({
      ...c,
      in_vault: keys ? keys.includes(c.name) : false,
      used_by: flows.filter((f) => connectionsUsedBy(f.graph).includes(c.name)).map((f) => ({ id: f.id, name: f.name })),
    }));
  }

  /** Creates or rotates a connection. The string is tested first (unless skipTest), then written to Vault. */
  async save(input: { name: string; connectionString?: string; description?: string; skipTest?: boolean }, mode: 'create' | 'update'): Promise<ConnectionRow> {
    const name = input.name;
    if (!CONNECTION_NAME_RE.test(name)) {
      throw new ConnectionError(400, 'Name must be lowercase letters, digits or _ (max 40) and start with a letter');
    }
    const existing = await this.db.getConnection(name);
    if (mode === 'create' && existing) throw new ConnectionError(409, `Connection "${name}" already exists`);
    if (mode === 'update' && !existing) throw new ConnectionError(404, `Connection "${name}" not found`);

    if (!input.connectionString) {
      if (mode === 'create') throw new ConnectionError(400, 'connectionString is required');
      return (await this.db.setConnectionDescription(name, input.description ?? existing!.description))!;
    }

    const details = describeConnectionString(input.connectionString);
    if (!input.skipTest) {
      const test = await this.testString(input.connectionString);
      if (!test.ok) throw new ConnectionError(422, `Connection test failed: ${test.error}`);
    }
    const description = input.description ?? existing?.description ?? '';
    await this.vault.put(name, { connectionString: input.connectionString, description });
    await this.db.upsertConnection({ name, description, ...details });
    if (!input.skipTest) await this.db.recordConnectionTest(name, true, null);
    // Rotation takes effect on the next query.
    if (mode === 'update') await this.invalidate(name);
    return (await this.db.getConnection(name))!;
  }

  async remove(name: string): Promise<void> {
    if (!(await this.db.getConnection(name))) throw new ConnectionError(404, `Connection "${name}" not found`);
    const users = (await this.db.list()).filter((f) => connectionsUsedBy(f.graph).includes(name));
    if (users.length) throw new ConnectionError(409, `Connection "${name}" is used by: ${users.map((f) => f.name).join(', ')}`);
    await this.vault.remove(name);
    await this.db.deleteConnection(name);
    await this.invalidate(name);
  }

  /** Tests a plaintext string directly (nothing is stored). */
  async testString(connectionString: string): Promise<QueryResult> {
    describeConnectionString(connectionString);
    return this.dbAccess.call<QueryResult>('POST', '/query', { connectionString, sql: 'SELECT 1 AS ok' });
  }

  /** Tests a stored connection the way flows use it: db-access resolves it from Vault. */
  async testStored(name: string): Promise<QueryResult> {
    if (!(await this.db.getConnection(name))) throw new ConnectionError(404, `Connection "${name}" not found`);
    const r = await this.query({ connection: name, sql: 'SELECT 1 AS ok' });
    await this.db.recordConnectionTest(name, r.ok, r.ok ? null : r.error);
    return r;
  }

  /** Runs SQL with a stored connection (inspector "Run query"). */
  query(req: { connection: string; sql: string; params?: Record<string, unknown>; maxRows?: number }): Promise<QueryResult> {
    return this.dbAccess.call<QueryResult>('POST', '/query', { maxRows: 50, ...req });
  }

  /** Connections referenced by a graph that don't exist. */
  async missingFor(graph: FlowGraph): Promise<string[]> {
    const known = new Set((await this.db.listConnections()).map((c) => c.name));
    return connectionsUsedBy(graph).filter((c) => !known.has(c));
  }

  /** Writes DB_CONN_<NAME> env vars to Vault when the name is not there yet. */
  async seedFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const seeded: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      const m = /^DB_CONN_([A-Z][A-Z0-9_]*)$/.exec(k);
      if (!m || !v) continue;
      const name = m[1].toLowerCase();
      if (await this.vault.get(name)) continue;
      const existing = await this.db.getConnection(name);
      const description = existing?.description || `Seeded from ${k}`;
      await this.vault.put(name, { connectionString: v, description });
      await this.db.upsertConnection({ name, description, ...describeConnectionString(v) });
      seeded.push(name);
    }
    return seeded;
  }

  /** Drops db-access's cached string (if db-access is running). */
  private async invalidate(name: string): Promise<void> {
    if (this.dbAccess.status().state !== 'running') return;
    await this.dbAccess.call('POST', '/invalidate', { connection: name }).catch((e) => this.log(`invalidate ${name}: ${(e as Error).message}`));
  }
}

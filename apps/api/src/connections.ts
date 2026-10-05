import { randomBytes } from 'node:crypto';
import { connectionVaultRef, type DatakitConfig, type FlowGraph } from '@ipaas/flow-core';
import type { ConnectionRow, Db } from './db';
import type { DbAccessManager } from './dbaccess';
import type { Gateway } from './gateway';
import type { Konnect } from './konnect';
import { uuidv5 } from './uuid';

export const CONNECTION_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TOKEN_KEY = 'ipaas_internal_token';
const SYSTEM_PATH = '/_ipaas/db-query';

export class ConnectionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ConnectionOptions {
  storeName: string;
  vaultPrefix: string;
  dbAccessUrl: string;
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
 * Database connection strings live only in a Konnect Config Store, exposed to
 * the data plane as a "konnect" vault ({vault://<prefix>/<name>}). Konnect never
 * returns secret values, so queries that need the stored string (the inspector's
 * "Run query", connection checks) go through a token-protected system route on
 * the gateway, where DataKit resolves the vault reference.
 */
export class ConnectionService {
  private storeId?: string;
  private token?: string;
  private setupPromise?: Promise<void>;

  constructor(
    private db: Db,
    private konnect: Konnect,
    private gateway: Gateway,
    private dbAccess: DbAccessManager,
    private opts: ConnectionOptions,
    private log: (msg: string) => void = console.log,
  ) {}

  get vaultPrefix(): string {
    return this.opts.vaultPrefix;
  }

  /** Config store + vault entity + internal token; idempotent. */
  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((e) => {
      this.setupPromise = undefined;
      throw e;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    this.storeId = await this.konnect.findOrCreateConfigStore(this.opts.storeName);
    await this.konnect.upsert('vaults', uuidv5('ipaas:db-vault'), {
      name: 'konnect',
      prefix: this.opts.vaultPrefix,
      description: 'iPaaS database connection strings',
      config: { config_store_id: this.storeId },
      tags: ['ipaas'],
    });
    this.token = await this.db.initSetting(TOKEN_KEY, randomBytes(24).toString('base64url'));
    await this.konnect.putSecret(this.storeId, TOKEN_KEY, this.token);
  }

  async list(): Promise<(ConnectionRow & { used_by: { id: string; name: string }[] })[]> {
    const [conns, flows] = await Promise.all([this.db.listConnections(), this.db.list()]);
    return conns.map((c) => ({
      ...c,
      used_by: flows.filter((f) => connectionsUsedBy(f.graph).includes(c.name)).map((f) => ({ id: f.id, name: f.name })),
    }));
  }

  /** Creates or rotates a connection. The string is tested first (unless skipTest) and then written to the vault. */
  async save(input: { name: string; connectionString?: string; description?: string; skipTest?: boolean }, mode: 'create' | 'update'): Promise<ConnectionRow> {
    const name = input.name;
    if (!CONNECTION_NAME_RE.test(name) || name.startsWith('ipaas_')) {
      throw new ConnectionError(400, 'Name must be lowercase letters, digits or _ (max 40), start with a letter, and not start with "ipaas_"');
    }
    const existing = await this.db.getConnection(name);
    if (mode === 'create' && existing) throw new ConnectionError(409, `Connection "${name}" already exists`);
    if (mode === 'update' && !existing) throw new ConnectionError(404, `Connection "${name}" not found`);

    if (!input.connectionString) {
      if (mode === 'create') throw new ConnectionError(400, 'connectionString is required');
      return (await this.db.setConnectionDescription(name, input.description ?? existing!.description))!;
    }

    const details = describeConnectionString(input.connectionString);
    let test: QueryResult | undefined;
    if (!input.skipTest) {
      test = await this.testString(input.connectionString);
      if (!test.ok) throw new ConnectionError(422, `Connection test failed: ${test.error}`);
    }
    await this.setup();
    await this.konnect.putSecret(this.storeId!, name, input.connectionString);
    const row = await this.db.upsertConnection({ name, description: input.description ?? existing?.description ?? '', ...details });
    if (test) await this.db.recordConnectionTest(name, true, null);
    if (mode === 'create') await this.deploySystemRoute();
    return (await this.db.getConnection(name)) ?? row;
  }

  async remove(name: string): Promise<void> {
    const conn = await this.db.getConnection(name);
    if (!conn) throw new ConnectionError(404, `Connection "${name}" not found`);
    const users = (await this.db.list()).filter((f) => connectionsUsedBy(f.graph).includes(name));
    if (users.length) throw new ConnectionError(409, `Connection "${name}" is used by: ${users.map((f) => f.name).join(', ')}`);
    await this.setup();
    await this.konnect.deleteSecret(this.storeId!, name);
    await this.db.deleteConnection(name);
    await this.deploySystemRoute();
  }

  /** Tests a plaintext string directly against db-access (nothing is stored). */
  async testString(connectionString: string): Promise<QueryResult> {
    describeConnectionString(connectionString);
    return this.dbAccess.call<QueryResult>('POST', '/query', { connectionString, sql: 'SELECT 1 AS ok' });
  }

  /** Tests the stored string end to end: vault -> data plane -> db-access -> database. */
  async testStored(name: string): Promise<QueryResult> {
    if (!(await this.db.getConnection(name))) throw new ConnectionError(404, `Connection "${name}" not found`);
    const r = await this.query({ connection: name, sql: 'SELECT 1 AS ok' });
    await this.db.recordConnectionTest(name, r.ok, r.ok ? null : r.error);
    return r;
  }

  /** Runs SQL with a stored connection through the gateway system route. */
  async query(req: { connection: string; sql: string; params?: Record<string, unknown>; maxRows?: number }): Promise<QueryResult> {
    await this.setup();
    const s = await this.dbAccess.ensure();
    if (s.state !== 'running') return { ok: false, error: `db-access is not running: ${s.error}` };
    const res = await this.gateway.invoke(SYSTEM_PATH, {
      method: 'POST',
      headers: { 'x-ipaas-token': this.token! },
      body: { maxRows: 50, ...req },
    });
    if (res.status === 404) return { ok: false, error: 'The query route is not on the data plane yet; try again in a few seconds' };
    if (res.status !== 200 || typeof res.body !== 'object') return { ok: false, error: `Gateway returned ${res.status}: ${JSON.stringify(res.body)}` };
    return res.body as QueryResult;
  }

  /** Existing connections must be present before a flow using them is deployed. */
  async missingFor(graph: FlowGraph): Promise<string[]> {
    const known = new Set((await this.db.listConnections()).map((c) => c.name));
    return connectionsUsedBy(graph).filter((c) => !known.has(c));
  }

  /** Seeds DB_CONN_<NAME> env vars into the vault once (existing names are left alone). */
  async seedFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const seeded: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      const m = /^DB_CONN_([A-Z][A-Z0-9_]*)$/.exec(k);
      if (!m || !v) continue;
      const name = m[1].toLowerCase();
      if (await this.db.getConnection(name)) continue;
      await this.save({ name, connectionString: v, description: `Seeded from ${k}`, skipTest: true }, 'create');
      seeded.push(name);
    }
    return seeded;
  }

  /** (Re)deploys the system route whose vault resources list every stored connection. */
  async deploySystemRoute(): Promise<void> {
    await this.setup();
    const names = (await this.db.listConnections()).map((c) => c.name);
    const ids = { service: uuidv5('ipaas:system:service'), route: uuidv5('ipaas:system:route'), plugin: uuidv5('ipaas:system:plugin') };
    const tags = ['ipaas', 'ipaas-system'];
    await this.konnect.upsert('services', ids.service, { name: 'ipaas-system', url: 'http://localhost:9', tags });
    await this.konnect.upsert('routes', ids.route, {
      name: 'ipaas-system-db-query', service: { id: ids.service }, paths: [SYSTEM_PATH], methods: ['POST'],
      protocols: ['http', 'https'], strip_path: true, tags,
    });
    await this.konnect.upsert('plugins', ids.plugin, {
      name: 'datakit', route: { id: ids.route }, enabled: true, tags,
      config: systemRouteConfig(names, this.opts.vaultPrefix, this.opts.dbAccessUrl),
    });
    this.log(`system route deployed with ${names.length} connection(s)`);
  }
}

/** DataKit config of the internal query route: token check, vault lookup by name, db-access call. */
export function systemRouteConfig(names: string[], prefix: string, dbAccessUrl: string): DatakitConfig {
  const vault: Record<string, string> = { token: connectionVaultRef(TOKEN_KEY, prefix) };
  const reqInputs: Record<string, string> = { b: 'request.body' };
  for (const n of names) {
    vault[`db_${n}`] = connectionVaultRef(n, prefix);
    reqInputs[`db_${n}`] = `vault.db_${n}`;
  }
  return {
    debug: false,
    resources: { vault },
    nodes: [
      { name: 'AUTH', type: 'jq', inputs: { h: 'request.headers', t: 'vault.token' }, jq: '(.t // "") != "" and ((.h["x-ipaas-token"] // "") == .t)' },
      { name: 'AUTH_GATE', type: 'branch', input: 'AUTH', then: ['REQ', 'CALL', 'OUT'], else: ['DENY_BODY', 'DENY'] },
      { name: 'DENY_BODY', type: 'jq', jq: '{ok: false, error: "forbidden"}' },
      { name: 'DENY', type: 'exit', status: 403, inputs: { body: 'DENY_BODY' } },
      {
        name: 'REQ', type: 'jq', inputs: reqInputs,
        jq: '.b as $b | {connection: $b.connection, connectionString: (.["db_" + ($b.connection // "")] // null), sql: $b.sql, params: ($b.params // {}), maxRows: ($b.maxRows // 50)}',
      },
      { name: 'CALL', type: 'call', method: 'POST', url: `${dbAccessUrl.replace(/\/+$/, '')}/query`, timeout: 15000, inputs: { body: 'REQ' } },
      { name: 'OUT', type: 'exit', status: 200, inputs: { body: 'CALL.body' } },
    ],
  };
}

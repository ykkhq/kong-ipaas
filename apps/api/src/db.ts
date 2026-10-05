import pg from 'pg';
import type { FlowGraph } from '@ipaas/flow-core';

export type FlowStatus = 'draft' | 'deploying' | 'live' | 'outdated' | 'error';

export interface FlowRow {
  id: string;
  name: string;
  slug: string;
  debug: boolean;
  graph: FlowGraph;
  version: number;
  status: FlowStatus;
  deployed_version: number | null;
  deployed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Non-secret connection details; the connection string itself lives only in Vault. */
export interface ConnectionRow {
  name: string;
  description: string;
  host: string;
  port: number;
  database: string;
  username: string;
  created_at: string;
  updated_at: string;
  tested_at: string | null;
  test_ok: boolean | null;
  test_error: string | null;
}

export class Db {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS flows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        debug boolean NOT NULL DEFAULT true,
        graph jsonb NOT NULL,
        version integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'draft',
        deployed_version integer,
        deployed_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS db_connections (
        name text PRIMARY KEY,
        description text NOT NULL DEFAULT '',
        host text NOT NULL,
        port integer NOT NULL,
        database text NOT NULL,
        username text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        tested_at timestamptz,
        test_ok boolean,
        test_error text
      );
      DROP TABLE IF EXISTS settings`);
  }

  // ---- connections -------------------------------------------------------------

  async listConnections(): Promise<ConnectionRow[]> {
    return (await this.pool.query<ConnectionRow>('SELECT * FROM db_connections ORDER BY name')).rows;
  }

  async getConnection(name: string): Promise<ConnectionRow | undefined> {
    return (await this.pool.query<ConnectionRow>('SELECT * FROM db_connections WHERE name = $1', [name])).rows[0];
  }

  async upsertConnection(c: Pick<ConnectionRow, 'name' | 'description' | 'host' | 'port' | 'database' | 'username'>): Promise<ConnectionRow> {
    const q = `INSERT INTO db_connections (name, description, host, port, database, username) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (name) DO UPDATE SET description = $2, host = $3, port = $4, database = $5, username = $6, updated_at = now()
      RETURNING *`;
    return (await this.pool.query<ConnectionRow>(q, [c.name, c.description, c.host, c.port, c.database, c.username])).rows[0];
  }

  async setConnectionDescription(name: string, description: string): Promise<ConnectionRow | undefined> {
    const q = 'UPDATE db_connections SET description = $2, updated_at = now() WHERE name = $1 RETURNING *';
    return (await this.pool.query<ConnectionRow>(q, [name, description])).rows[0];
  }

  async recordConnectionTest(name: string, ok: boolean, error: string | null): Promise<void> {
    await this.pool.query('UPDATE db_connections SET tested_at = now(), test_ok = $2, test_error = $3 WHERE name = $1', [name, ok, error]);
  }

  async deleteConnection(name: string): Promise<void> {
    await this.pool.query('DELETE FROM db_connections WHERE name = $1', [name]);
  }

  async list(): Promise<FlowRow[]> {
    return (await this.pool.query<FlowRow>('SELECT * FROM flows ORDER BY created_at')).rows;
  }

  async get(id: string): Promise<FlowRow | undefined> {
    return (await this.pool.query<FlowRow>('SELECT * FROM flows WHERE id = $1', [id])).rows[0];
  }

  async create(f: { name: string; slug: string; debug?: boolean; graph: FlowGraph }): Promise<FlowRow> {
    const q = 'INSERT INTO flows (name, slug, debug, graph) VALUES ($1, $2, $3, $4) RETURNING *';
    return (await this.pool.query<FlowRow>(q, [f.name, f.slug, f.debug ?? true, JSON.stringify(f.graph)])).rows[0];
  }

  /** Saves a new revision; a live flow becomes "outdated" until redeployed. */
  async update(id: string, f: { name: string; slug: string; debug?: boolean; graph: FlowGraph }): Promise<FlowRow | undefined> {
    const q = `UPDATE flows SET name = $2, slug = $3, debug = $4, graph = $5, version = version + 1, updated_at = now(),
      status = CASE WHEN status = 'live' THEN 'outdated' ELSE status END
      WHERE id = $1 RETURNING *`;
    return (await this.pool.query<FlowRow>(q, [id, f.name, f.slug, f.debug ?? true, JSON.stringify(f.graph)])).rows[0];
  }

  async setStatus(id: string, status: FlowStatus, extra: { deployed_version?: number | null; last_error?: string | null } = {}): Promise<FlowRow> {
    const q = `UPDATE flows SET status = $2,
      deployed_version = CASE WHEN $3::boolean THEN $4::integer ELSE deployed_version END,
      deployed_at = CASE WHEN $3::boolean THEN (CASE WHEN $4::integer IS NULL THEN NULL ELSE now() END) ELSE deployed_at END,
      last_error = $5
      WHERE id = $1 RETURNING *`;
    const hasDeployed = 'deployed_version' in extra;
    return (await this.pool.query<FlowRow>(q, [id, status, hasDeployed, extra.deployed_version ?? null, extra.last_error ?? null])).rows[0];
  }

  async remove(id: string): Promise<void> {
    await this.pool.query('DELETE FROM flows WHERE id = $1', [id]);
  }
}

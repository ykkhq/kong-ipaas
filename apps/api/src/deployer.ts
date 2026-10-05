import { compileFlow, type CompileOptions, type CompileResult } from '@ipaas/flow-core';
import type { ConnectionService } from './connections';
import { usesDatabase, type DbAccessManager } from './dbaccess';
import type { Db, FlowRow } from './db';
import type { Gateway } from './gateway';
import type { Konnect } from './konnect';
import { uuidv5 } from './uuid';

export function entityIds(flowId: string) {
  return {
    service: uuidv5(`${flowId}:service`),
    route: uuidv5(`${flowId}:route`),
    plugin: uuidv5(`${flowId}:plugin`),
  };
}

export function compileRow(row: Pick<FlowRow, 'name' | 'slug' | 'debug' | 'graph'>, opts: CompileOptions = {}): CompileResult {
  return compileFlow({ name: row.name, slug: row.slug, debug: row.debug, graph: row.graph }, opts);
}

export class Deployer {
  constructor(
    private db: Db,
    private konnect: Konnect,
    private gateway: Gateway,
    private syncTimeoutMs: number,
    private dbAccess?: DbAccessManager,
    private connections?: ConnectionService,
  ) {}

  compile(row: Pick<FlowRow, 'name' | 'slug' | 'debug' | 'graph'>): CompileResult {
    return compileRow(row, { dbAccessUrl: this.dbAccess?.url, dbVaultPrefix: this.connections?.vaultPrefix });
  }

  /** Pushes service + route + DataKit plugin to Konnect, then waits for the DP to pick it up. */
  async deploy(row: FlowRow): Promise<{ row: FlowRow; compiled: CompileResult; synced: boolean }> {
    const compiled = this.compile(row);
    if (!compiled.ok) {
      const err = compiled.errors.map((e) => e.message).join('; ');
      return { row: await this.db.setStatus(row.id, 'error', { last_error: err }), compiled, synced: false };
    }
    await this.db.setStatus(row.id, 'deploying');
    const ids = entityIds(row.id);
    const tags = ['ipaas', `flow-${row.id}`];
    try {
      if (this.dbAccess && usesDatabase(row.graph)) {
        if (this.connections) {
          const missing = await this.connections.missingFor(row.graph);
          if (missing.length) throw new Error(`Unknown database connection(s): ${missing.join(', ')}. Create them under Connections first.`);
          await this.connections.setup();
        }
        const s = await this.dbAccess.ensure();
        if (s.state !== 'running') throw new Error(`db-access is not running: ${s.error}`);
      }
      const before = (await this.gateway.status()).configHash;
      await this.konnect.upsert('services', ids.service, {
        name: `ipaas-${row.slug}`,
        // Never proxied: every flow ends in a DataKit exit node.
        url: 'http://localhost:9',
        tags,
      });
      await this.konnect.upsert('routes', ids.route, {
        name: `ipaas-${row.slug}`,
        service: { id: ids.service },
        paths: [compiled.route!.path],
        methods: [compiled.route!.method],
        protocols: ['http', 'https'],
        strip_path: true,
        tags,
      });
      await this.konnect.upsert('plugins', ids.plugin, {
        name: 'datakit',
        route: { id: ids.route },
        config: compiled.config,
        enabled: true,
        tags,
      });
      const synced = await this.gateway.waitForSync(before, this.syncTimeoutMs);
      const updated = await this.db.setStatus(row.id, 'live', {
        deployed_version: row.version,
        last_error: synced ? null : 'Pushed to Konnect, but the local data plane has not confirmed the new config yet',
      });
      return { row: updated, compiled, synced };
    } catch (e) {
      return { row: await this.db.setStatus(row.id, 'error', { last_error: (e as Error).message }), compiled, synced: false };
    }
  }

  async undeploy(row: FlowRow): Promise<FlowRow> {
    const ids = entityIds(row.id);
    const before = (await this.gateway.status()).configHash;
    // Children first: plugin -> route -> service.
    await this.konnect.remove('plugins', ids.plugin);
    await this.konnect.remove('routes', ids.route);
    await this.konnect.remove('services', ids.service);
    await this.gateway.waitForSync(before, Math.min(this.syncTimeoutMs, 15000));
    return this.db.setStatus(row.id, 'draft', { deployed_version: null, last_error: null });
  }
}

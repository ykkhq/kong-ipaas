import os from 'node:os';
import type { FlowGraph } from '@ipaas/flow-core';
import { Docker } from './docker';

export interface DbAccessOptions {
  image: string;
  containerName: string;
  /** Base URL used by the API and the data plane (network alias of the container). */
  url: string;
  /** Network alias that the URL resolves to. */
  alias: string;
  /** Docker network to attach to; defaults to the API container's own network. */
  network?: string;
  /** Extra env for the container (tuning only; it holds no credentials). */
  env: Record<string, string>;
}

export interface DbAccessStatus {
  state: 'absent' | 'starting' | 'running' | 'error';
  container?: string;
  image?: string;
  error?: string;
}

export const usesDatabase = (graph: FlowGraph) => graph.nodes.some((n) => n.type === 'database');

/**
 * Runs the db-access container on demand: it is created the first time a flow
 * contains a Database node, then kept running (restart: unless-stopped).
 */
export class DbAccessManager {
  private inflight?: Promise<DbAccessStatus>;
  private last: DbAccessStatus = { state: 'absent' };

  constructor(private opts: DbAccessOptions, private docker = new Docker(), private fetchImpl: typeof fetch = fetch) {}

  get url(): string {
    return this.opts.url;
  }

  status(): DbAccessStatus {
    return this.last;
  }

  /** Creates/starts the container if needed and waits until it answers /health. */
  ensure(): Promise<DbAccessStatus> {
    this.inflight ??= this.doEnsure()
      .then((s) => (this.last = s))
      .catch((e) => (this.last = { state: 'error', error: (e as Error).message }))
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async doEnsure(): Promise<DbAccessStatus> {
    const { image, containerName } = this.opts;
    const img = await this.docker.inspectImage(image);
    if (!img) throw new Error(`Image ${image} not found; run "docker compose build" first`);

    let c = await this.docker.inspectContainer(containerName);
    if (c && c.Image !== img.Id) {
      // Image was rebuilt: replace the container so the new code runs.
      await this.docker.request('DELETE', `/containers/${c.Id}?force=true`);
      c = null;
    }
    if (!c) {
      this.last = { state: 'starting', image };
      const network = this.opts.network ?? (await this.ownNetwork());
      const env = Object.entries(this.opts.env).map(([k, v]) => `${k}=${v}`);
      c = await this.docker.request('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, {
        Image: image,
        Env: env,
        Labels: { 'ipaas.managed-by': 'api', 'ipaas.component': 'db-access' },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: network },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [this.opts.alias] } } },
      });
      c = await this.docker.inspectContainer(containerName);
    }
    if (!c.State?.Running) await this.docker.request('POST', `/containers/${c.Id}/start`);

    await this.waitHealthy(20000);
    return { state: 'running', container: containerName, image };
  }

  private async waitHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const r = await this.fetchImpl(`${this.opts.url}/health`);
        if (r.ok) return;
        lastErr = `HTTP ${r.status}`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`db-access did not become healthy: ${lastErr}`);
  }

  /** The compose network of the API container itself (HOSTNAME is the container id). */
  private async ownNetwork(): Promise<string> {
    const self = await this.docker.inspectContainer(os.hostname());
    const nets = Object.keys(self?.NetworkSettings?.Networks ?? {});
    if (!nets.length) throw new Error('Cannot determine the docker network; set DB_ACCESS_NETWORK');
    return nets[0];
  }

  async remove(): Promise<void> {
    const c = await this.docker.inspectContainer(this.opts.containerName).catch(() => null);
    if (c) await this.docker.request('DELETE', `/containers/${c.Id}?force=true`);
    this.last = { state: 'absent' };
  }

  /** Forwards a request to the running service (starting it first). */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const s = await this.ensure();
    if (s.state !== 'running') throw new Error(s.error ?? 'db-access is not running');
    const r = await this.fetchImpl(`${this.opts.url}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await r.json()) as T;
  }
}

/** db-access tuning vars from the API's env. Connection strings are never passed: they come from the vault per request. */
export function dbAccessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['STATEMENT_TIMEOUT_MS', 'MAX_ROWS', 'MAX_POOLS']) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

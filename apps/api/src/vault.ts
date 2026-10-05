import { readFileSync } from 'node:fs';

export class VaultError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface StoredConnection { connectionString: string; description?: string }

/** Minimal KV v2 client for connection strings at <mount>/db/<name>. */
export class VaultClient {
  constructor(
    readonly addr: string,
    private tokenFile: string,
    private mount = 'ipaas',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private token(): string {
    return process.env.VAULT_TOKEN || readFileSync(this.tokenFile, 'utf8').trim();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.addr}/v1/${path}`, {
        method,
        headers: { 'X-Vault-Token': this.token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new VaultError(0, `Vault unreachable at ${this.addr}: ${(e as Error).message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const errors = ((await res.json().catch(() => ({}))) as { errors?: string[] }).errors;
      throw new VaultError(res.status, `Vault ${method} ${path} → ${res.status}${errors?.length ? `: ${errors.join('; ')}` : ''}`);
    }
    return res.status === 204 ? null : ((await res.json()) as T);
  }

  async ready(): Promise<boolean> {
    try {
      const r = await this.fetchImpl(`${this.addr}/v1/sys/health`);
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async put(name: string, value: StoredConnection): Promise<void> {
    await this.req('POST', `${this.mount}/data/db/${encodeURIComponent(name)}`, { data: value });
  }

  async get(name: string): Promise<StoredConnection | null> {
    const r = await this.req<{ data: { data: StoredConnection } }>('GET', `${this.mount}/data/db/${encodeURIComponent(name)}`);
    return r?.data.data ?? null;
  }

  /** Deletes all versions and metadata. */
  async remove(name: string): Promise<void> {
    await this.req('DELETE', `${this.mount}/metadata/db/${encodeURIComponent(name)}`);
  }

  async list(): Promise<string[]> {
    const r = await this.req<{ data: { keys: string[] } }>('LIST', `${this.mount}/metadata/db`);
    return r?.data.keys ?? [];
  }

  /** Keeps the periodic token alive. */
  async renewSelf(): Promise<void> {
    await this.req('POST', 'auth/token/renew-self');
  }
}

export function readTokenFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

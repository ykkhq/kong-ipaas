import { readFileSync } from 'node:fs';

/** KV v2 access under <mount>/edi/… (policy ipaas-edi). */
export class Vault {
  constructor(private addr: string, private tokenFile: string, private mount = 'ipaas', private fetchImpl: typeof fetch = fetch) {}

  private token(): string {
    return process.env.VAULT_TOKEN || readFileSync(this.tokenFile, 'utf8').trim();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await this.fetchImpl(`${this.addr}/v1/${path}`, {
      method,
      headers: { 'X-Vault-Token': this.token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Vault ${method} ${path} → ${res.status}`);
    return res.status === 204 ? null : ((await res.json()) as T);
  }

  async get<T extends Record<string, string>>(key: string): Promise<T | null> {
    const r = await this.req<{ data: { data: T } }>('GET', `${this.mount}/data/edi/${key}`);
    return r?.data.data ?? null;
  }

  async put(key: string, data: Record<string, string>): Promise<void> {
    await this.req('POST', `${this.mount}/data/edi/${key}`, { data });
  }

  /** Merges fields into an existing secret (empty strings delete a field). */
  async merge(key: string, patch: Record<string, string | undefined>): Promise<void> {
    const cur = (await this.get(key)) ?? {};
    const next: Record<string, string> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === '') delete next[k];
      else next[k] = v;
    }
    await this.put(key, next);
  }

  async remove(key: string): Promise<void> {
    await this.req('DELETE', `${this.mount}/metadata/edi/${key}`);
  }

  async ready(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.addr}/v1/sys/health`)).status === 200;
    } catch {
      return false;
    }
  }

  async renewSelf(): Promise<void> {
    await this.req('POST', 'auth/token/renew-self');
  }
}

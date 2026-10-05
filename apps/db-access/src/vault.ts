/**
 * Reads connection strings from the local Vault (KV v2) by connection name,
 * with a short cache. The API calls /invalidate after a rotation, so a new
 * string applies immediately; the TTL is only a fallback.
 */
export class VaultResolver {
  private cache = new Map<string, { value: string; at: number }>();

  constructor(
    private addr: string,
    private tokenSource: () => string,
    private mount = 'ipaas',
    private ttlMs = 60000,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async connectionString(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const res = await this.fetchImpl(`${this.addr}/v1/${this.mount}/data/db/${encodeURIComponent(name)}`, {
      headers: { 'X-Vault-Token': this.tokenSource() },
    });
    if (res.status === 404) throw new ResolveError(`Unknown connection "${name}"`);
    if (!res.ok) throw new ResolveError(`Vault returned ${res.status} for connection "${name}"`);
    const body = (await res.json()) as { data?: { data?: { connectionString?: string } } };
    const value = body.data?.data?.connectionString;
    if (!value) throw new ResolveError(`Connection "${name}" has no connectionString in Vault`);
    this.cache.set(name, { value, at: Date.now() });
    return value;
  }

  /** Forgets cached strings; returns them so their pools can be closed. */
  invalidate(name?: string): string[] {
    const dropped = name ? [this.cache.get(name)?.value].filter((v): v is string => Boolean(v)) : [...this.cache.values()].map((c) => c.value);
    if (name) this.cache.delete(name);
    else this.cache.clear();
    return dropped;
  }

  /** Keeps the periodic token alive. */
  async renewToken(): Promise<void> {
    await this.fetchImpl(`${this.addr}/v1/auth/token/renew-self`, { method: 'POST', headers: { 'X-Vault-Token': this.tokenSource() } });
  }
}

export class ResolveError extends Error {}

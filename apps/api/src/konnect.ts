export class KonnectError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
  }
}

type Entity = 'services' | 'routes' | 'plugins' | 'vaults';

/** Minimal client for the Konnect control-plane Admin API (core entities). */
export class Konnect {
  private cpIdPromise?: Promise<string>;
  readonly base: string;

  constructor(private pat: string, region: string, private cpName: string, private fetchImpl: typeof fetch = fetch) {
    this.base = `https://${region}.api.konghq.com/v2`;
  }

  get configured(): boolean {
    return Boolean(this.pat);
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.pat) throw new KonnectError(0, null, 'KONNECT_PAT is not set');
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.pat}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const detail = describe(data) ?? text;
      throw new KonnectError(res.status, data, `Konnect ${method} ${path} → ${res.status}: ${detail}`);
    }
    return data as T;
  }

  /** Resolves the control plane id by name (created by konnect-init); cached on success. */
  cpId(): Promise<string> {
    this.cpIdPromise ??= this.request<{ data: { id: string }[] }>('GET', `/control-planes?filter%5Bname%5D%5Beq%5D=${encodeURIComponent(this.cpName)}`)
      .then((r) => {
        const id = r.data?.[0]?.id;
        if (!id) throw new KonnectError(404, r, `Control plane "${this.cpName}" not found; did konnect-init run?`);
        return id;
      })
      .catch((e) => {
        this.cpIdPromise = undefined;
        throw e;
      });
    return this.cpIdPromise;
  }

  async upsert(entity: Entity, id: string, body: Record<string, unknown>) {
    return this.request('PUT', `/control-planes/${await this.cpId()}/core-entities/${entity}/${id}`, body);
  }

  async remove(entity: Entity, id: string): Promise<void> {
    try {
      await this.request('DELETE', `/control-planes/${await this.cpId()}/core-entities/${entity}/${id}`);
    } catch (e) {
      if (!(e instanceof KonnectError && e.status === 404)) throw e;
    }
  }

  /** Deletes an entity; returns false if it did not exist. */
  async removeIfExists(entity: Entity, id: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/control-planes/${await this.cpId()}/core-entities/${entity}/${id}`);
      return true;
    } catch (e) {
      if (e instanceof KonnectError && e.status === 404) return false;
      throw e;
    }
  }

  /** Deletes a Config Store and its secrets by name; returns false if absent. */
  async deleteConfigStoreByName(name: string): Promise<boolean> {
    const cp = await this.cpId();
    const list = await this.request<{ data: { id: string; name: string }[] }>('GET', `/control-planes/${cp}/config-stores`);
    const hit = list.data?.find((c) => c.name === name);
    if (!hit) return false;
    // A store can only be deleted once it is empty.
    const base = `/control-planes/${cp}/config-stores/${hit.id}`;
    const secrets = await this.request<{ data: { key: string }[] }>('GET', `${base}/secrets`);
    for (const { key } of secrets.data ?? []) await this.request('DELETE', `${base}/secrets/${encodeURIComponent(key)}`);
    await this.request('DELETE', base);
    return true;
  }

  /** Data plane nodes connected to the control plane. */
  async nodes(): Promise<{ id: string; hostname: string; version: string; last_ping: number; config_hash?: string }[]> {
    const r = await this.request<{ items?: any[]; data?: any[] }>('GET', `/control-planes/${await this.cpId()}/nodes`);
    return r.items ?? r.data ?? [];
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(data: any): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const parts = [data.message ?? data.detail ?? data.title];
  if (data.fields) parts.push(JSON.stringify(data.fields));
  if (Array.isArray(data.invalid_parameters)) parts.push(data.invalid_parameters.map((p: any) => `${p.field}: ${p.reason}`).join('; '));
  return parts.filter(Boolean).join(' — ') || undefined;
}

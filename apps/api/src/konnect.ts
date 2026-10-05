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

  // ---- Config Store (backs the "konnect" vault) -------------------------------

  async findOrCreateConfigStore(name: string): Promise<string> {
    const cp = await this.cpId();
    const list = await this.request<{ data: { id: string; name: string }[] }>('GET', `/control-planes/${cp}/config-stores`);
    const hit = list.data?.find((c) => c.name === name);
    if (hit) return hit.id;
    return (await this.request<{ id: string }>('POST', `/control-planes/${cp}/config-stores`, { name })).id;
  }

  /** Secrets are write-only: Konnect never returns the value. */
  async putSecret(storeId: string, key: string, value: string): Promise<void> {
    const base = `/control-planes/${await this.cpId()}/config-stores/${storeId}/secrets`;
    try {
      await this.request('PUT', `${base}/${encodeURIComponent(key)}`, { value });
    } catch (e) {
      if (!(e instanceof KonnectError && e.status === 404)) throw e;
      await this.request('POST', base, { key, value });
    }
  }

  async deleteSecret(storeId: string, key: string): Promise<void> {
    try {
      await this.request('DELETE', `/control-planes/${await this.cpId()}/config-stores/${storeId}/secrets/${encodeURIComponent(key)}`);
    } catch (e) {
      if (!(e instanceof KonnectError && e.status === 404)) throw e;
    }
  }

  async listSecretKeys(storeId: string): Promise<string[]> {
    const r = await this.request<{ data: { key: string }[] }>('GET', `/control-planes/${await this.cpId()}/config-stores/${storeId}/secrets`);
    return (r.data ?? []).map((s) => s.key);
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

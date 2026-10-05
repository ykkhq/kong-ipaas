/** Talks to the local data plane: config-hash polling and flow invocation. */
export class Gateway {
  constructor(private proxyUrl: string, private statusUrl: string, private fetchImpl: typeof fetch = fetch, private settleMs = 2000) {}

  async status(): Promise<{ ready: boolean; configHash?: string }> {
    try {
      const [ready, status] = await Promise.all([
        this.fetchImpl(`${this.statusUrl}/status/ready`).then((r) => r.ok),
        this.fetchImpl(`${this.statusUrl}/status`).then((r) => r.json() as Promise<{ configuration_hash?: string }>),
      ]);
      return { ready, configHash: status.configuration_hash };
    } catch {
      return { ready: false };
    }
  }

  /** Resolves true once the DP's configuration hash differs from `before`. */
  async waitForSync(before: string | undefined, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { configHash } = await this.status();
      if (configHash && configHash !== before && !/^0+$/.test(configHash)) {
        // The hash flips before every worker has rebuilt its router; give them a moment.
        await new Promise((r) => setTimeout(r, this.settleMs));
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async invoke(path: string, req: { method: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; trace?: boolean }) {
    const url = new URL(path, this.proxyUrl);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.trace) headers['X-DataKit-Debug-Trace'] = 'true';
    let body: string | undefined;
    if (req.body !== undefined && req.body !== null && req.body !== '' && req.method !== 'GET') {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      headers['Content-Type'] ??= 'application/json';
    }
    const started = performance.now();
    const res = await this.fetchImpl(url, { method: req.method, headers, body });
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, headers: Object.fromEntries(res.headers), body: parsed, latencyMs, url: url.toString() };
  }
}

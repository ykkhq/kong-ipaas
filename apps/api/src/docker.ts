import http from 'node:http';

export class DockerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Minimal Docker Engine API client over the unix socket. */
export class Docker {
  constructor(private socketPath = '/var/run/docker.sock') {}

  request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: `/v1.43${path}`,
          method,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            const parsed = data ? safeJson(data) : null;
            if ((res.statusCode ?? 500) >= 300) {
              const msg = (parsed as any)?.message ?? data ?? `HTTP ${res.statusCode}`;
              reject(new DockerError(res.statusCode ?? 500, `Docker ${method} ${path} → ${res.statusCode}: ${msg}`));
            } else resolve(parsed as T);
          });
        },
      );
      req.on('error', (e) => reject(new DockerError(0, `Docker socket ${this.socketPath} unavailable: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async inspectContainer(name: string): Promise<any | null> {
    try {
      return await this.request('GET', `/containers/${encodeURIComponent(name)}/json`);
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  }

  async inspectImage(ref: string): Promise<any | null> {
    try {
      return await this.request('GET', `/images/${encodeURIComponent(ref)}/json`);
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

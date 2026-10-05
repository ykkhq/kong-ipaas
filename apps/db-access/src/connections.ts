import { createHash } from 'node:crypto';
import pg from 'pg';

/**
 * Connection pools keyed by a hash of the connection string. db-access holds no
 * credentials of its own: the string arrives per request, resolved by the Kong
 * data plane from the Konnect vault. Strings are never logged.
 */
export class Pools {
  private pools = new Map<string, { pool: pg.Pool; lastUsed: number }>();

  constructor(private statementTimeoutMs: number, private maxPools = 20) {}

  get(connectionString: string): pg.Pool {
    const key = createHash('sha256').update(connectionString).digest('hex');
    const hit = this.pools.get(key);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit.pool;
    }
    if (this.pools.size >= this.maxPools) this.evictOldest();
    const pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: this.statementTimeoutMs,
      application_name: 'ipaas-db-access',
    });
    // Idle-client errors (e.g. DB restart) must not crash the process.
    pool.on('error', (e) => console.error(`pool ${key.slice(0, 8)}: ${e.message}`));
    this.pools.set(key, { pool, lastUsed: Date.now() });
    return pool;
  }

  get size(): number {
    return this.pools.size;
  }

  private evictOldest(): void {
    const [key, oldest] = [...this.pools].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    this.pools.delete(key);
    oldest.pool.end().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.pool.end()));
  }
}

/** Accepts postgres:// and postgresql:// URLs only. */
export function validConnectionString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

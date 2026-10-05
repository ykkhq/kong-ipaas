import { buildApp } from './app';
import { readFileSync } from 'node:fs';
import { Pools } from './connections';
import { VaultResolver } from './vault';

const pools = new Pools(Number(process.env.STATEMENT_TIMEOUT_MS ?? 10000), Number(process.env.MAX_POOLS ?? 20));
// Token from env, or from the file the Vault bootstrap writes (mounted read-only).
const tokenFile = process.env.VAULT_TOKEN_FILE ?? '/vault/keys/db-access-token';
const token = () => process.env.VAULT_TOKEN || readFileSync(tokenFile, 'utf8').trim();
const vault = process.env.VAULT_ADDR
  ? new VaultResolver(process.env.VAULT_ADDR, token, process.env.VAULT_KV_MOUNT ?? 'ipaas', Number(process.env.VAULT_CACHE_TTL_MS ?? 60000))
  : undefined;
const app = buildApp(pools, { defaultMaxRows: Number(process.env.MAX_ROWS ?? 1000), vault });
if (vault) setInterval(() => vault.renewToken().catch((e) => app.log.warn(`token renew failed: ${e.message}`)), 12 * 3600 * 1000).unref();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pools.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4020) });

import { buildApp } from './app';
import { Pools } from './connections';

const pools = new Pools(Number(process.env.STATEMENT_TIMEOUT_MS ?? 10000), Number(process.env.MAX_POOLS ?? 20));
const app = buildApp(pools, { defaultMaxRows: Number(process.env.MAX_ROWS ?? 1000) });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pools.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4020) });

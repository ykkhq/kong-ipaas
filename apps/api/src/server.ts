import { buildApp, seedExamples } from './app';
import { config } from './config';
import { ConnectionService } from './connections';
import { Db } from './db';
import { DbAccessManager, dbAccessEnv, usesDatabase } from './dbaccess';
import { Deployer } from './deployer';
import { Gateway } from './gateway';
import { Konnect } from './konnect';

const db = new Db(config.databaseUrl);
for (let attempt = 1; ; attempt++) {
  try {
    await db.migrate();
    break;
  } catch (e) {
    if (attempt >= 30) throw e;
    console.log(`waiting for postgres (${(e as Error).message})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!(await db.list()).length) await seedExamples(db, config.mocksUrl);

const konnect = new Konnect(config.konnect.pat, config.konnect.region, config.konnect.cpName);
const gateway = new Gateway(config.dpProxyUrl, config.dpStatusUrl);
const dbAccess = new DbAccessManager({ ...config.dbAccess, env: dbAccessEnv() });
const connections = new ConnectionService(db, konnect, gateway, dbAccess, { ...config.connections, dbAccessUrl: dbAccess.url });
const deployer = new Deployer(db, konnect, gateway, config.syncTimeoutMs, dbAccess, connections);
const app = buildApp({ db, konnect, gateway, deployer, dbAccess, connections, publicGatewayUrl: config.publicGatewayUrl });

await app.listen({ host: '0.0.0.0', port: config.port });

// Vault + system route in Konnect, and DB_CONN_* seeds (e.g. the stub "sample" DB).
if (konnect.configured) {
  (async () => {
    await connections.setup();
    const seeded = await connections.seedFromEnv();
    if (seeded.length) app.log.info(`seeded connections into the vault: ${seeded.join(', ')}`);
    else await connections.deploySystemRoute();
  })().catch((e) => app.log.error(`connection setup failed: ${(e as Error).message}`));
}

// Keep db-access running while any flow has a Database node.
if ((await db.list()).some((f) => usesDatabase(f.graph))) {
  dbAccess.ensure().then((s) => app.log.info(`db-access: ${s.state}${s.error ? ` (${s.error})` : ''}`));
}

// db-access is not a compose service, so remove it when the stack goes down.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    app.log.info(`${sig}: stopping`);
    await dbAccess.remove().catch((e) => app.log.error(`db-access cleanup: ${(e as Error).message}`));
    await app.close();
    process.exit(0);
  });
}

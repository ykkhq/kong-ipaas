import { buildApp, seedExamples } from './app';
import { config } from './config';
import { ConnectionService } from './connections';
import { Db } from './db';
import { DbAccessManager, dbAccessEnv, usesDatabase } from './dbaccess';
import { removeKonnectVaultSetup } from './legacy';
import { VaultClient, readTokenFile } from './vault';
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
const vault = new VaultClient(config.vault.addr, config.vault.apiTokenFile, config.vault.mount);
const dbAccess = new DbAccessManager({
  ...config.dbAccess,
  env: () => dbAccessEnv(process.env, { ...config.vault, token: readTokenFile(config.vault.dbAccessTokenFile) }),
});
const connections = new ConnectionService(db, vault, dbAccess, (m) => app.log.info(m));
const deployer = new Deployer(db, konnect, gateway, config.syncTimeoutMs, dbAccess, connections, config.ediGatewayUrl);
const app = buildApp({ db, konnect, gateway, deployer, dbAccess, connections, publicGatewayUrl: config.publicGatewayUrl });

await app.listen({ host: '0.0.0.0', port: config.port });

// DB_CONN_* seeds into Vault (e.g. the stub "sample" DB), and token renewal.
(async () => {
  await connections.ready();
  const seeded = await connections.seedFromEnv();
  if (seeded.length) app.log.info(`seeded connections into Vault: ${seeded.join(', ')}`);
})().catch((e) => app.log.error(`connection setup failed: ${(e as Error).message}`));
setInterval(() => vault.renewSelf().catch((e) => app.log.warn(`vault token renew: ${(e as Error).message}`)), 12 * 3600 * 1000).unref();

// Remove the v0.2.0 Konnect vault setup (connection strings now live in Vault),
// then redeploy live database flows, whose configs still point at that vault.
if (konnect.configured) {
  (async () => {
    const removed = await removeKonnectVaultSetup(konnect);
    if (!removed.length) return;
    app.log.info(`removed legacy Konnect entities: ${removed.join(', ')}`);
    await connections.ready();
    await connections.seedFromEnv();
    for (const row of await db.list()) {
      if (row.deployed_version == null || !usesDatabase(row.graph)) continue;
      const { row: r } = await deployer.deploy(row);
      app.log.info(`redeployed ${row.slug} for local Vault: ${r.status}${r.last_error ? ` (${r.last_error})` : ''}`);
    }
  })().catch((e) => app.log.warn(`legacy cleanup: ${(e as Error).message}`));
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

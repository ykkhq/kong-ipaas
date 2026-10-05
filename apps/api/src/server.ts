import { buildApp, seedExamples } from './app';
import { config } from './config';
import { Db } from './db';
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
const deployer = new Deployer(db, konnect, gateway, config.syncTimeoutMs);
const app = buildApp({ db, konnect, gateway, deployer, publicGatewayUrl: config.publicGatewayUrl });

await app.listen({ host: '0.0.0.0', port: config.port });

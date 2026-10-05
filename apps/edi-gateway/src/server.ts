import { buildAdmin } from './admin';
import { config } from './config';
import { Db } from './db';
import { Engine } from './engine';
import { As2Adapter } from './protocols/as2/adapter';
import { Oftp2Adapter } from './protocols/oftp2/adapter';
import { EbmsAdapter } from './protocols/ebms/adapter';
import { JxAdapter } from './protocols/jx/adapter';
import { SftpAdapter } from './protocols/sftp/adapter';
import { PayloadStore } from './store';
import { Vault } from './vault';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const db = new Db(config.databaseUrl);
const vault = new Vault(config.vault.addr, config.vault.tokenFile, config.vault.mount);
const store = new PayloadStore(config.dataDir);

for (let i = 1; ; i++) {
  try {
    await db.migrate();
    if (!(await vault.ready())) throw new Error('vault not ready');
    break;
  } catch (e) {
    if (i >= 60) throw e;
    log(`waiting for dependencies: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const engine = new Engine(db, store, config.gatewayUrl, log);
const ctx = { db, vault, engine, log };
const sftp = new SftpAdapter(ctx, { dataDir: config.dataDir, port: config.sftp.port, pollIntervalMs: config.sftp.pollIntervalMs });
const as2 = new As2Adapter(ctx, { port: config.as2.port, publicUrl: config.as2.publicUrl, timeoutMs: config.as2.httpTimeoutMs });
const oftp2 = new Oftp2Adapter(ctx, store, { port: config.oftp2.port, tlsPort: config.oftp2.tlsPort });
engine.register(sftp);
engine.register(as2);
const ebms = new EbmsAdapter(ctx, store, config.ebms);
engine.register(oftp2);
const jx = new JxAdapter(ctx, store, config.jx);
engine.register(ebms);
engine.register(jx);

// First start: a hosted SFTP demo partner without credentials (nobody can log in until
// a key or password is set); documents sent to it land in its /outbox.
if (!(await db.listPartners()).length) {
  await db.createPartner({ name: 'demo-sftp', protocol: 'sftp', enabled: true, config: { mode: 'hosted', username: 'demo' }, inbound_flow: 'edi-inbox' });
  log('created demo partner demo-sftp (hosted SFTP, no credentials yet)');
}

const admin = buildAdmin({ db, vault, engine, store, as2, sftp, oftp2, jx, sftpPort: config.sftp.port });
await admin.listen({ host: '0.0.0.0', port: config.port });
await sftp.start();
await as2.start();
await oftp2.start();
await ebms.start();
await jx.start();
log(`edi-gateway admin on :${config.port}`);

setInterval(() => vault.renewSelf().catch((e) => log(`vault token renew: ${e.message}`)), 12 * 3600 * 1000).unref();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    await Promise.allSettled([admin.close(), sftp.stop(), as2.stop(), oftp2.stop(), ebms.stop(), jx.stop()]);
    process.exit(0);
  });
}

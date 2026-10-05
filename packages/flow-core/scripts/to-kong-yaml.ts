// Dev helper: compiles the example flows into a DB-less kong.yaml for local DataKit testing.
// MOCKS=http://host.docker.internal:4010 DB_ACCESS_URL=http://db-access:4020 npx tsx scripts/to-kong-yaml.ts > kong.yaml
import { compileFlow, exampleFlows } from '../src/index';
import { readFileSync } from 'node:fs';
import { stringify } from 'yaml';
const mocks = process.env.MOCKS ?? 'http://host.docker.internal:4010';
const extra = process.env.EXTRA ? JSON.parse(readFileSync(process.env.EXTRA, 'utf8')) : [];
const services = [...exampleFlows(mocks), ...extra].map((f) => {
  const r = compileFlow(f, { dbAccessUrl: process.env.DB_ACCESS_URL });
  if (!r.ok) { console.error(f.slug, r.errors); process.exit(1); }
  return { name: f.slug, url: 'http://localhost:9', routes: [{ name: f.slug, paths: [r.route!.path], methods: [r.route!.method], protocols: ['http', 'https'], plugins: [{ name: 'datakit', config: r.config }] }] };
});
console.log(stringify({ _format_version: '3.0', services }));

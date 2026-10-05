// Dev helper: compiles the example flows into a DB-less kong.yaml for local DataKit testing.
// MOCKS=http://host.docker.internal:4010 npx tsx scripts/to-kong-yaml.ts > kong.yaml
import { compileFlow, exampleFlows } from '../src/index';
import { stringify } from 'yaml';
const mocks = process.env.MOCKS ?? 'http://host.docker.internal:4010';
const services = exampleFlows(mocks).map((f) => {
  const r = compileFlow(f);
  if (!r.ok) { console.error(f.slug, r.errors); process.exit(1); }
  return { name: f.slug, url: 'http://localhost:9', routes: [{ name: f.slug, paths: [r.route!.path], methods: [r.route!.method], protocols: ['http', 'https'], plugins: [{ name: 'datakit', config: r.config }] }] };
});
console.log(stringify({ _format_version: '3.0', services }));

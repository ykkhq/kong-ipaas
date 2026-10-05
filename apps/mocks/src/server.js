// Sample "job" APIs used by the seeded flows. MOCK_DELAY_MS adds latency so
// parallel execution inside DataKit is observable.
import Fastify from 'fastify';

const app = Fastify({ logger: true });
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const users = {
  1: { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', city: 'London', tier: 'gold' },
  2: { id: 2, name: 'Grace Hopper', email: 'grace@example.com', city: 'New York', tier: 'silver' },
  3: { id: 3, name: 'Yukihiro Matsumoto', email: 'matz@example.com', city: 'Tokyo', tier: 'gold' },
};

const orders = {
  1: [{ id: 'o-100', total: 120.5, status: 'shipped' }, { id: 'o-101', total: 42, status: 'pending' }],
  2: [{ id: 'o-200', total: 9.99, status: 'delivered' }],
  3: [],
};

const weather = {
  London: { temp_c: 14, condition: 'Cloudy' },
  'New York': { temp_c: 21, condition: 'Sunny' },
  Tokyo: { temp_c: 24, condition: 'Rain' },
};

app.addHook('preHandler', async (req) => {
  const d = Number(req.query?.delay ?? DELAY);
  if (d > 0) await sleep(d);
});

app.get('/health', async () => ({ ok: true }));

app.get('/users/:id', async (req, reply) => {
  const u = users[req.params.id];
  if (!u) return reply.code(404).send({ error: 'user not found' });
  return u;
});

app.get('/users/:id/orders', async (req) => {
  const list = orders[req.params.id] ?? [];
  return { user_id: Number(req.params.id), count: list.length, orders: list };
});

app.get('/weather', async (req, reply) => {
  const w = weather[req.query.city];
  if (!w) return reply.code(404).send({ error: 'unknown city' });
  return { city: req.query.city, ...w };
});

app.get('/loyalty/:tier', async (req) => ({
  tier: req.params.tier,
  discount_pct: { gold: 15, silver: 5 }[req.params.tier] ?? 0,
}));

app.get('/inventory', async (_req, reply) => {
  reply.type('application/xml');
  return `<?xml version="1.0"?>
<inventory>
  <item><sku>A-1</sku><name>Widget</name><qty>12</qty></item>
  <item><sku>B-2</sku><name>Gadget</name><qty>0</qty></item>
</inventory>`;
});

// Echo endpoint, handy for testing request templating.
app.all('/echo', async (req) => ({ method: req.method, query: req.query, headers: req.headers, body: req.body ?? null }));

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4010) });

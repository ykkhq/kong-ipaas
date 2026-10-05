import type { Flow } from './schema';

/** Seed flows. `mocks` is the base URL of the mock job service as seen from the data plane. */
export function exampleFlows(mocks = 'http://mocks:4010'): Flow[] {
  return [
    {
      name: 'Customer 360',
      slug: 'customer-360',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', position: { x: 0, y: 160 }, data: { label: 'Request', method: 'GET' } },
          { id: 'user', type: 'http', position: { x: 280, y: 40 }, data: { label: 'Get User', method: 'GET', url: `${mocks}/users/{{ .req.query.id // "1" }}` } },
          { id: 'orders', type: 'http', position: { x: 280, y: 280 }, data: { label: 'Get Orders', method: 'GET', url: `${mocks}/users/{{ .req.query.id // "1" }}/orders` } },
          { id: 'weather', type: 'http', position: { x: 560, y: 0 }, data: { label: 'Get Weather', method: 'GET', url: `${mocks}/weather`, query: '{city: .user.city}' } },
          { id: 'gold', type: 'condition', position: { x: 560, y: 140 }, data: { label: 'Is Gold', expr: '.user.tier == "gold"' } },
          { id: 'loyalty', type: 'http', position: { x: 820, y: 140 }, data: { label: 'Get Loyalty', method: 'GET', url: `${mocks}/loyalty/{{ .user.tier }}` } },
          {
            id: 'response', type: 'response', position: { x: 1100, y: 160 },
            data: {
              label: 'Response', status: 200,
              expr: '{customer: .user, orders: .orders.orders, order_count: .orders.count, weather: .weather, loyalty: (.loyalty // {discount_pct: 0})}',
            },
          },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'user', data: { alias: 'req' } },
          { id: 'e2', source: 'trigger', target: 'orders', data: { alias: 'req' } },
          { id: 'e3', source: 'user', target: 'weather', data: { alias: 'user' } },
          { id: 'e4', source: 'user', target: 'gold', data: { alias: 'user' } },
          { id: 'e5', source: 'gold', target: 'loyalty', sourceHandle: 'then' },
          { id: 'e6', source: 'user', target: 'loyalty', data: { alias: 'user' } },
          { id: 'e7', source: 'user', target: 'response', data: { alias: 'user' } },
          { id: 'e8', source: 'orders', target: 'response', data: { alias: 'orders' } },
          { id: 'e9', source: 'weather', target: 'response', data: { alias: 'weather' } },
          { id: 'e10', source: 'loyalty', target: 'response', data: { alias: 'loyalty' } },
        ],
      },
    },
    {
      name: 'Inventory (XML to JSON)',
      slug: 'inventory',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', position: { x: 0, y: 100 }, data: { label: 'Request', method: 'GET' } },
          { id: 'fetch', type: 'http', position: { x: 260, y: 100 }, data: { label: 'Fetch Inventory', method: 'GET', url: `${mocks}/inventory` } },
          { id: 'parse', type: 'xml', position: { x: 520, y: 100 }, data: { label: 'Parse XML' } },
          { id: 'shape', type: 'transform', position: { x: 760, y: 100 }, data: { label: 'In Stock', expr: '.inv | [.. | objects | select(has("sku"))] | map(select((.qty | tonumber) > 0))' } },
          { id: 'response', type: 'response', position: { x: 1000, y: 100 }, data: { label: 'Response', status: 200, expr: '{in_stock: .in_stock}' } },
        ],
        edges: [
          { id: 'e1', source: 'fetch', target: 'parse', data: { alias: 'xml' } },
          { id: 'e2', source: 'parse', target: 'shape', data: { alias: 'inv' } },
          { id: 'e3', source: 'shape', target: 'response', data: { alias: 'in_stock' } },
        ],
      },
    },
  ];
}

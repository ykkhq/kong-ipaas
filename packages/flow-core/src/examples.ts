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
      name: 'Customer from Database',
      slug: 'customer-db',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', position: { x: 0, y: 160 }, data: { label: 'Request', method: 'GET' } },
          {
            id: 'customer', type: 'database', position: { x: 280, y: 40 },
            data: {
              label: 'Find Customer', connection: 'sample',
              sql: 'SELECT id, name, email, city, tier\nFROM customers\nWHERE id = :id',
              params: { id: '.req.query.id // "1"' },
            },
          },
          {
            id: 'orders', type: 'database', position: { x: 280, y: 280 },
            data: {
              label: 'Customer Orders', connection: 'sample',
              sql: [
                'SELECT o.id, o.status, o.created_at,',
                '       sum(p.price * i.qty)::float AS total,',
                '       count(*)::int AS items',
                'FROM orders o',
                'JOIN order_items i ON i.order_id = o.id',
                'JOIN products p ON p.sku = i.sku',
                'WHERE o.customer_id = :id',
                'GROUP BY o.id',
                'ORDER BY o.created_at DESC',
              ].join('\n'),
              params: { id: '.req.query.id // "1"' },
            },
          },
          { id: 'found', type: 'condition', position: { x: 580, y: 40 }, data: { label: 'Customer Found', expr: '.customer.row_count > 0' } },
          { id: 'weather', type: 'http', position: { x: 840, y: 0 }, data: { label: 'Get Weather', method: 'GET', url: `${mocks}/weather`, query: '{city: .customer.rows[0].city}' } },
          {
            id: 'response', type: 'response', position: { x: 1120, y: 160 },
            data: {
              label: 'Response', status: 200,
              expr: 'if .customer.row_count == 0 then {error: "customer not found"} else {customer: .customer.rows[0], orders: .orders.rows, order_count: .orders.row_count, weather: .weather} end',
            },
          },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'customer', data: { alias: 'req' } },
          { id: 'e2', source: 'trigger', target: 'orders', data: { alias: 'req' } },
          { id: 'e3', source: 'customer', target: 'weather', data: { alias: 'customer' } },
          { id: 'e7', source: 'customer', target: 'found', data: { alias: 'customer' } },
          { id: 'e8', source: 'found', target: 'weather', sourceHandle: 'then' },
          { id: 'e4', source: 'customer', target: 'response', data: { alias: 'customer' } },
          { id: 'e5', source: 'orders', target: 'response', data: { alias: 'orders' } },
          { id: 'e6', source: 'weather', target: 'response', data: { alias: 'weather' } },
        ],
      },
    },
    {
      // Inbound: edi-gateway POSTs every document received from a partner whose inbound flow is "edi-inbox".
      name: 'EDI Inbox',
      slug: 'edi-inbox',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', position: { x: 0, y: 100 }, data: { label: 'EDI Document', method: 'POST' } },
          {
            id: 'parse', type: 'transform', position: { x: 280, y: 100 },
            data: {
              label: 'Summarize',
              expr: '.doc.body as $b | {partner: $b.edi.partner, protocol: $b.edi.protocol, file: $b.edi.filename, size: $b.edi.size, '
                + 'lines: (if $b.encoding == "utf8" then ($b.document | split("\\n") | map(select(length > 0)) | length) else null end), '
                + 'first_line: (if $b.encoding == "utf8" then ($b.document | split("\\n") | .[0]) else null end)}',
            },
          },
          { id: 'response', type: 'response', position: { x: 560, y: 100 }, data: { label: 'Response', status: 200, expr: '{accepted: true, summary: .summary}' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'parse', data: { alias: 'doc' } },
          { id: 'e2', source: 'parse', target: 'response', data: { alias: 'summary' } },
        ],
      },
    },
    {
      // Outbound: database -> CSV -> EDI Send (partner "demo-sftp" drops the file in its /outbox).
      name: 'Orders to EDI',
      slug: 'orders-to-edi',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', position: { x: 0, y: 140 }, data: { label: 'Request', method: 'GET' } },
          {
            id: 'orders', type: 'database', position: { x: 260, y: 40 },
            data: {
              label: 'Customer Orders', connection: 'sample',
              sql: 'SELECT o.id, o.status, sum(p.price * i.qty)::float AS total\nFROM orders o\nJOIN order_items i ON i.order_id = o.id\nJOIN products p ON p.sku = i.sku\nWHERE o.customer_id = :id\nGROUP BY o.id\nORDER BY o.id',
              params: { id: '.req.query.id // "1"' },
            },
          },
          {
            id: 'csv', type: 'transform', position: { x: 520, y: 40 },
            data: { label: 'To CSV', expr: '"order_id,status,total\\n" + (.orders.rows | map("\\(.id),\\(.status),\\(.total)") | join("\\n")) + "\\n"' },
          },
          {
            id: 'send', type: 'edi_send', position: { x: 780, y: 140 },
            data: { label: 'Send to Partner', partner: 'demo-sftp', filename: '"orders-" + (.req.query.id // "1") + ".csv"', content: '.csv', contentType: 'text/csv' },
          },
          { id: 'response', type: 'response', position: { x: 1040, y: 140 }, data: { label: 'Response', status: 200, expr: '{sent: .edi, orders: .orders.row_count}' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'orders', data: { alias: 'req' } },
          { id: 'e2', source: 'orders', target: 'csv', data: { alias: 'orders' } },
          { id: 'e3', source: 'csv', target: 'send', data: { alias: 'csv' } },
          { id: 'e4', source: 'trigger', target: 'send', data: { alias: 'req' } },
          { id: 'e5', source: 'send', target: 'response', data: { alias: 'edi' } },
          { id: 'e6', source: 'orders', target: 'response', data: { alias: 'orders' } },
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

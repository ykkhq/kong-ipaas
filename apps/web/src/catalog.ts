import type { FlowNode, NodeDataByKind, NodeKind } from '@ipaas/flow-core';

export interface KindInfo {
  title: string;
  description: string;
  color: string;
  glyph: string;
  /** Accepts incoming data edges. */
  inputs: boolean;
  /** Has an outgoing data handle (conditions use then/else instead). */
  output: boolean;
  /** Only one per flow. */
  singleton?: boolean;
  defaults: () => NodeDataByKind[NodeKind];
}

export const KINDS: Record<NodeKind, KindInfo> = {
  trigger: {
    title: 'Trigger', description: 'Incoming endpoint request', color: '#38bdf8', glyph: '⚡', inputs: false, output: true, singleton: true,
    defaults: () => ({ label: 'Request', method: 'GET' }),
  },
  http: {
    title: 'HTTP Job', description: 'Call an API (runs in parallel unless chained)', color: '#a78bfa', glyph: '⇄', inputs: true, output: true,
    defaults: () => ({ label: 'Call API', method: 'GET', url: 'http://mocks:4010/users/1' }),
  },
  database: {
    title: 'Database', description: 'Run a SQL query (variables are bound safely)', color: '#60a5fa', glyph: '⛁', inputs: true, output: true,
    defaults: () => ({ label: 'Query', connection: 'sample', sql: 'SELECT *\nFROM customers\nWHERE id = :id', params: { id: '.req.query.id // "1"' } }),
  },
  edi_send: {
    title: 'EDI Send', description: 'Send a document to a trading partner (AS2, SFTP, …)', color: '#22d3ee', glyph: '✉', inputs: true, output: true,
    defaults: () => ({ label: 'Send EDI', partner: '', filename: '"document.edi"', content: '.req.body', contentType: 'application/octet-stream' }),
  },
  transform: {
    title: 'Transform', description: 'Reshape data with jq', color: '#f472b6', glyph: '{ }', inputs: true, output: true,
    defaults: () => ({ label: 'Transform', expr: '.' }),
  },
  condition: {
    title: 'Condition', description: 'Run downstream jobs only if true / false', color: '#fbbf24', glyph: '◇', inputs: true, output: false,
    defaults: () => ({ label: 'Condition', expr: 'true' }),
  },
  static: {
    title: 'Static', description: 'Constant values', color: '#94a3b8', glyph: '≡', inputs: false, output: true,
    defaults: () => ({ label: 'Constants', values: { key: 'value' } }),
  },
  secret: {
    title: 'Secret', description: 'Env var from the data plane vault', color: '#fb923c', glyph: '🔑', inputs: false, output: true,
    defaults: () => ({ label: 'Api Key', env: 'IPAAS_SECRET_API_KEY' }),
  },
  xml: {
    title: 'XML → JSON', description: 'Parse an XML payload', color: '#2dd4bf', glyph: '</>', inputs: true, output: true,
    defaults: () => ({ label: 'Parse XML' }),
  },
  response: {
    title: 'Response', description: 'Aggregate results and reply', color: '#34d399', glyph: '↩', inputs: true, output: false, singleton: true,
    defaults: () => ({ label: 'Response', status: 200, expr: '.' }),
  },
};

export const PALETTE: NodeKind[] = ['trigger', 'http', 'database', 'edi_send', 'transform', 'condition', 'static', 'secret', 'xml', 'response'];

let seq = 0;
export function newNode(kind: NodeKind, position: { x: number; y: number }): FlowNode {
  return { id: `${kind}-${Date.now().toString(36)}-${seq++}`, type: kind, position, data: KINDS[kind].defaults() } as FlowNode;
}

export function blankGraph() {
  return {
    nodes: [newNode('trigger', { x: 0, y: 100 }), newNode('response', { x: 600, y: 100 })],
    edges: [],
  };
}

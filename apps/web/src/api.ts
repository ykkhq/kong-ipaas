import type { CompileError, FlowGraph, TraceSummary } from '@ipaas/flow-core';

export type FlowStatus = 'draft' | 'deploying' | 'live' | 'outdated' | 'error';

export interface FlowRecord {
  id: string;
  name: string;
  slug: string;
  debug: boolean;
  graph: FlowGraph;
  version: number;
  status: FlowStatus;
  deployed_version: number | null;
  deployed_at: string | null;
  last_error: string | null;
  endpoint: string;
  updated_at: string;
}

export interface CompileResponse {
  ok: boolean;
  errors: CompileError[];
  yaml: string | null;
  nodeMap: Record<string, string[]>;
  route?: { path: string; method: string };
}

export interface TestResponse {
  request: { method: string; url: string };
  status: number;
  latencyMs: number;
  headers: Record<string, string>;
  body: unknown;
  trace?: TraceSummary;
}

export interface PlatformStatus {
  dataPlane: { ready: boolean; configHash?: string };
  controlPlane: { id?: string; error?: string; nodes?: { hostname: string; version: string; last_ping: number }[] };
  gatewayUrl: string;
}

/** Connection metadata; the connection string itself is only in Vault. */
export interface DbConnection {
  name: string;
  description: string;
  host: string;
  port: number;
  database: string;
  username: string;
  created_at: string;
  updated_at: string;
  tested_at: string | null;
  test_ok: boolean | null;
  test_error: string | null;
  in_vault: boolean;
  used_by: { id: string; name: string }[];
}

export type QueryResult =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number; fields: string[]; truncated: boolean; durationMs: number }
  | { ok: false; error: string; code?: string; detail?: string; hint?: string; position?: string };

// ---- EDI (edi-gateway admin API via /api/edi) -------------------------------
export type EdiProtocol = 'sftp' | 'as2' | 'oftp2' | 'ebms' | 'jx';

export interface EdiPartner {
  id: string;
  name: string;
  protocol: EdiProtocol;
  enabled: boolean;
  config: Record<string, any>;
  inbound_flow: string | null;
  secrets: Record<string, boolean>;
  updated_at: string;
}

export interface EdiMessage {
  id: string;
  direction: 'in' | 'out';
  protocol: EdiProtocol;
  partner_id: string | null;
  partner_name: string | null;
  status: string;
  message_id: string | null;
  filename: string | null;
  content_type: string | null;
  size: number;
  receipt: Record<string, any> | null;
  error: string | null;
  flow_slug: string | null;
  flow_status: number | null;
  created_at: string;
}

export interface EdiStation {
  as2: { as2Id?: string; email?: string; publicUrl?: string; certificate: string | null; certInfo: { subject: string; notAfter: string; fingerprint: string } | null };
  sftp: { port: number; hostKeyFingerprint: string };
  ebms: { partyId?: string; partyIdType?: string };
  jx: { jxId?: string; domain?: string };
  oftp2: { odetteId?: string; certificate: string | null; certInfo: { subject: string; notAfter: string; fingerprint: string } | null; cipherSuites: Record<string, string> };
}

export type EdiPartnerInput = Pick<EdiPartner, 'name' | 'protocol' | 'enabled' | 'config' | 'inbound_flow'> & { secrets?: Record<string, string> };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: any) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? data.message ?? `HTTP ${res.status}`, res.status, data);
  return data as T;
}

type FlowInput = Pick<FlowRecord, 'name' | 'slug' | 'debug' | 'graph'>;

export const api = {
  status: () => call<PlatformStatus>('GET', '/status'),
  list: () => call<FlowRecord[]>('GET', '/flows'),
  get: (id: string) => call<FlowRecord>('GET', `/flows/${id}`),
  create: (f: FlowInput) => call<FlowRecord>('POST', '/flows', f),
  update: (id: string, f: FlowInput) => call<FlowRecord>('PUT', `/flows/${id}`, f),
  remove: (id: string) => call<void>('DELETE', `/flows/${id}`),
  compile: (f: FlowInput) => call<CompileResponse>('POST', '/compile', f),
  deploy: (id: string) => call<{ flow: FlowRecord; synced: boolean }>('POST', `/flows/${id}/deploy`),
  undeploy: (id: string) => call<{ flow: FlowRecord }>('POST', `/flows/${id}/undeploy`),
  test: (id: string, req: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; trace?: boolean }) =>
    call<TestResponse>('POST', `/flows/${id}/test`, req),
  seedExamples: () => call<FlowRecord[]>('POST', '/examples', {}),
  connections: () => call<DbConnection[]>('GET', '/connections'),
  createConnection: (c: { name: string; connectionString: string; description?: string; skipTest?: boolean }) => call<DbConnection>('POST', '/connections', c),
  updateConnection: (name: string, c: { connectionString?: string; description?: string; skipTest?: boolean }) => call<DbConnection>('PUT', `/connections/${name}`, c),
  deleteConnection: (name: string) => call<void>('DELETE', `/connections/${name}`),
  testConnectionString: (connectionString: string) => call<QueryResult>('POST', '/connections/test', { connectionString }),
  testConnection: (name: string) => call<QueryResult>('POST', `/connections/${name}/test`),
  edi: {
    partners: () => call<EdiPartner[]>('GET', '/edi/partners'),
    createPartner: (p: EdiPartnerInput) => call<EdiPartner>('POST', '/edi/partners', p),
    updatePartner: (id: string, p: EdiPartnerInput) => call<EdiPartner>('PUT', `/edi/partners/${id}`, p),
    deletePartner: (id: string) => call<void>('DELETE', `/edi/partners/${id}`),
    testPartner: (id: string) => call<{ ok: boolean; error?: string; hostKey?: string; files?: string[]; httpStatus?: number }>('POST', `/edi/partners/${id}/test`),
    pollPartner: (id: string) => call<{ ok: boolean; received?: number; error?: string }>('POST', `/edi/partners/${id}/poll`),
    messages: (q: { partner?: string; direction?: string; limit?: number } = {}) =>
      call<EdiMessage[]>('GET', `/edi/messages?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
    forward: (id: string) => call<EdiMessage>('POST', `/edi/messages/${id}/forward`),
    send: (b: { partner: string; filename?: string; contentType?: string; content: string }) =>
      call<{ ok: boolean; id?: string; status?: string; messageId?: string; error?: string; receipt?: Record<string, any> }>('POST', '/edi/send', b),
    station: () => call<EdiStation>('GET', '/edi/station'),
    saveAs2Station: (s: { as2Id: string; email?: string; publicUrl?: string }) => call<{ ok: boolean }>('PUT', '/edi/station/as2', s),
    as2Certificate: (b: { generate?: boolean; certificate?: string; privateKey?: string }) => call<{ ok: boolean }>('POST', '/edi/station/as2/certificate', b),
    saveJxStation: (s: { jxId: string; domain?: string }) => call<{ ok: boolean }>('PUT', '/edi/station/jx', s),
    saveEbmsStation: (s: { partyId: string; partyIdType?: string }) => call<{ ok: boolean }>('PUT', '/edi/station/ebms', s),
    saveOftpStation: (s: { odetteId: string }) => call<{ ok: boolean }>('PUT', '/edi/station/oftp2', s),
    oftpCertificate: (b: { generate?: boolean; certificate?: string; privateKey?: string }) => call<{ ok: boolean }>('POST', '/edi/station/oftp2/certificate', b),
  },
  dbQuery: (req: { connection: string; sql: string; params?: Record<string, unknown> }) => call<QueryResult>('POST', '/db/query', req),
};

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
};

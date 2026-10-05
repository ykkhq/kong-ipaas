// Parses the DataKit debug trace (X-DataKit-Debug-Trace: true) into per-node
// states that the designer can paint onto the canvas.

export interface TraceEvent {
  name: string;
  action: 'run' | 'dispatch' | 'resume' | 'complete' | 'fail' | 'skip' | 'cancel' | string;
  at: string;
  node_type?: string;
  value?: unknown;
  error?: string;
}

export type NodeState = 'complete' | 'fail' | 'skip' | 'cancel' | 'running';

export interface NodeTrace {
  name: string;
  type?: string;
  state: NodeState;
  startMs?: number;
  endMs?: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface TraceSummary {
  status: string;
  totalMs: number;
  /** One entry per DataKit node, in first-seen order. */
  nodes: NodeTrace[];
  /** Aggregated state per designer node id. */
  byUiNode: Record<string, NodeTrace>;
  /** The body the exit node returned (trace mode replaces the HTTP body). */
  exit?: { name: string; body: unknown };
}

/** DataKit wraps values as {type, value}; objects nest wrappers per field. */
export function unwrap(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if ('type' in o && 'value' in o) {
    if (o.type === 'object' && o.value && typeof o.value === 'object') {
      return Object.fromEntries(Object.entries(o.value as Record<string, unknown>).map(([k, x]) => [k, unwrap(x)]));
    }
    return o.value;
  }
  return v;
}

const RANK: Record<NodeState, number> = { fail: 5, cancel: 4, running: 3, skip: 2, complete: 1 };

export function summarizeTrace(
  trace: { status?: string; events?: TraceEvent[] },
  nodeMap: Record<string, string[]> = {},
  failPaths: Record<string, string[]> = {},
): TraceSummary {
  const events = trace.events ?? [];
  const t0 = events.length ? BigInt(events[0].at) : 0n;
  const ms = (at: string) => Number(BigInt(at) - t0) / 1e6;
  const nodes = new Map<string, NodeTrace>();
  let exit: TraceSummary['exit'];
  let end = 0;

  for (const e of events) {
    const n = nodes.get(e.name) ?? { name: e.name, type: e.node_type, state: 'running' as NodeState };
    n.type ??= e.node_type;
    const t = ms(e.at);
    end = Math.max(end, t);
    switch (e.action) {
      case 'run':
        n.startMs ??= t;
        n.input = unwrap(e.value);
        if (e.node_type === 'exit') {
          const input = n.input as { body?: unknown; status?: unknown } | undefined;
          exit = { name: e.name, body: input?.body ?? null };
        }
        break;
      case 'complete':
        n.state = 'complete';
        n.endMs = t;
        if (e.value !== undefined) n.output = unwrap(e.value);
        break;
      case 'fail':
        n.state = 'fail';
        n.endMs = t;
        n.error = e.error ?? unwrap(e.value);
        break;
      case 'skip':
      case 'cancel':
        n.state = e.action;
        n.startMs ??= t;
        n.endMs = t;
        break;
    }
    nodes.set(e.name, n);
  }

  const byUiNode: Record<string, NodeTrace> = {};
  for (const [uiId, names] of Object.entries(nodeMap)) {
    const parts = names.map((x) => nodes.get(x)).filter((x): x is NodeTrace => Boolean(x));
    if (!parts.length) continue;
    // The last name is the node's primary output (call/exit/branch); helpers come first.
    const main = nodes.get(names.find((x) => !x.includes('__')) ?? names[0]) ?? parts[parts.length - 1];
    const worst = parts.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    byUiNode[uiId] = {
      ...main,
      state: worst.state,
      error: worst.error ?? main.error,
      startMs: Math.min(...parts.map((p) => p.startMs ?? Infinity)),
      endMs: Math.max(...parts.map((p) => p.endMs ?? 0)),
    };
  }

  // Error paths (e.g. a failed database query): if the error exit ran, the node failed.
  for (const [uiId, [bodyName, exitName]] of Object.entries(failPaths)) {
    const ran = nodes.get(exitName);
    if (ran?.state !== 'complete' || !byUiNode[uiId]) continue;
    byUiNode[uiId] = { ...byUiNode[uiId], state: 'fail', error: nodes.get(bodyName)?.output };
  }

  return { status: trace.status ?? 'UNKNOWN', totalMs: end, nodes: [...nodes.values()], byUiNode, exit };
}

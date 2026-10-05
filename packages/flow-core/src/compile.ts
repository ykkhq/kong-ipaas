import type { DatabaseData, Flow, FlowEdge, FlowNode, HttpJobData, NodeKind } from './schema';
import { HTTP_METHODS, SLUG_RE } from './schema';
import { ALIAS_RE, NameAllocator, lowerSnake, upperSnake } from './naming';
import { hasPlaceholders, templateFallback, templateToJq } from './template';

export interface CompileError { message: string; nodeId?: string; edgeId?: string }

export interface DatakitNode { name: string; type: string; [key: string]: unknown }

export interface DatakitConfig {
  debug: boolean;
  nodes: DatakitNode[];
  resources?: { vault?: Record<string, string> };
}

export interface CompileResult {
  ok: boolean;
  errors: CompileError[];
  config?: DatakitConfig;
  route?: { path: string; method: string };
  /** UI node id -> DataKit node names it compiled into (used to map traces onto the canvas). */
  nodeMap: Record<string, string[]>;
  /** UI node id -> error-path node names (body jq, exit) that run only when the node fails. */
  failPaths: Record<string, string[]>;
}

export interface CompileOptions {
  /** Base URL of the db-access service as seen from the data plane. */
  dbAccessUrl?: string;
}

export const DEFAULT_DB_ACCESS_URL = 'http://db-access:4020';


/** A data input of a node: the alias it gets in jq, and the DataKit references feeding it. */
interface DataInput { alias: string; edge: FlowEdge; source: FlowNode }

const NO_DATA_OUT: NodeKind[] = ['condition', 'response'];
const NO_DATA_IN: NodeKind[] = ['trigger', 'static', 'secret'];

export function compileFlow(flow: Flow, opts: CompileOptions = {}): CompileResult {
  const errors: CompileError[] = [];
  const nodeMap: Record<string, string[]> = {};
  const failPaths: Record<string, string[]> = {};
  const fail = (): CompileResult => ({ ok: false, errors, nodeMap, failPaths });
  const dbAccessUrl = (opts.dbAccessUrl ?? DEFAULT_DB_ACCESS_URL).replace(/\/+$/, '');
  const { nodes, edges } = flow.graph;

  if (!SLUG_RE.test(flow.slug)) errors.push({ message: `Invalid slug "${flow.slug}" (use lowercase letters, digits and dashes)` });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const triggers = nodes.filter((n) => n.type === 'trigger');
  const responses = nodes.filter((n) => n.type === 'response');
  if (triggers.length !== 1) errors.push({ message: `A flow needs exactly one Trigger (found ${triggers.length})` });
  if (responses.length !== 1) errors.push({ message: `A flow needs exactly one Response (found ${responses.length})` });

  // ---- edge classification -------------------------------------------------
  const dataIn = new Map<string, DataInput[]>(nodes.map((n) => [n.id, []]));
  const control = new Map<string, { then: string[]; else: string[] }>();
  const parents = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  const children = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));

  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) { errors.push({ edgeId: e.id, message: 'Edge references a missing node' }); continue; }
    if (e.source === e.target) { errors.push({ edgeId: e.id, message: 'A node cannot connect to itself' }); continue; }
    parents.get(dst.id)!.add(src.id);
    children.get(src.id)!.add(dst.id);

    if (src.type === 'condition') {
      const handle = e.sourceHandle === 'else' ? 'else' : e.sourceHandle === 'then' ? 'then' : null;
      if (!handle) { errors.push({ edgeId: e.id, nodeId: src.id, message: 'Condition edges must leave from the "then" or "else" handle' }); continue; }
      if (dst.type === 'response') { errors.push({ edgeId: e.id, nodeId: dst.id, message: 'A condition cannot gate the Response; gate the jobs instead' }); continue; }
      const c = control.get(src.id) ?? { then: [], else: [] };
      c[handle].push(dst.id);
      control.set(src.id, c);
      continue;
    }
    if (NO_DATA_OUT.includes(src.type)) { errors.push({ edgeId: e.id, nodeId: src.id, message: `${src.data.label} has no data output` }); continue; }
    if (NO_DATA_IN.includes(dst.type)) { errors.push({ edgeId: e.id, nodeId: dst.id, message: `${dst.data.label} does not accept inputs` }); continue; }

    const alias = e.data?.alias?.trim() || lowerSnake(src.data.label);
    if (!ALIAS_RE.test(alias)) { errors.push({ edgeId: e.id, message: `Invalid input alias "${alias}" (use snake_case)` }); continue; }
    const list = dataIn.get(dst.id)!;
    if (list.some((i) => i.alias === alias)) { errors.push({ edgeId: e.id, nodeId: dst.id, message: `Duplicate input alias "${alias}" on ${dst.data.label}` }); continue; }
    list.push({ alias, edge: e, source: src });
  }

  // ---- topological order (Kahn) ---------------------------------------------
  const indeg = new Map(nodes.map((n) => [n.id, parents.get(n.id)!.size]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: FlowNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => indeg.get(n.id)! > 0);
    for (const n of stuck) errors.push({ nodeId: n.id, message: `${n.data.label} is part of a cycle` });
  }

  // ---- per-node validation --------------------------------------------------
  for (const n of nodes) {
    const ins = dataIn.get(n.id)!;
    switch (n.type) {
      case 'trigger':
        if (!HTTP_METHODS.includes(n.data.method)) errors.push({ nodeId: n.id, message: 'Trigger method is invalid' });
        break;
      case 'http':
        if (!HTTP_METHODS.includes(n.data.method)) errors.push({ nodeId: n.id, message: 'HTTP method is invalid' });
        if (!/^https?:\/\//.test(n.data.url ?? '')) errors.push({ nodeId: n.id, message: `${n.data.label}: URL must start with http:// or https://` });
        if (!ins.length && (hasPlaceholders(n.data.url ?? '') || n.data.query || n.data.headers || n.data.body))
          errors.push({ nodeId: n.id, message: `${n.data.label} uses templates but has no inputs connected` });
        break;
      case 'transform':
      case 'condition':
        if (!n.data.expr?.trim()) errors.push({ nodeId: n.id, message: `${n.data.label}: jq expression is empty` });
        if (n.type === 'condition' && !control.get(n.id)) errors.push({ nodeId: n.id, message: `${n.data.label} gates nothing; connect its then/else handles` });
        break;
      case 'xml':
        if (ins.length !== 1) errors.push({ nodeId: n.id, message: `${n.data.label} needs exactly one input` });
        break;
      case 'secret':
        if (!/^[A-Z_][A-Z0-9_]*$/.test(n.data.env ?? '')) errors.push({ nodeId: n.id, message: `${n.data.label}: env var name must be UPPER_SNAKE` });
        break;
      case 'database': {
        const d = n.data;
        if (!/^[a-z0-9_]+$/.test(d.connection ?? '')) errors.push({ nodeId: n.id, message: `${d.label}: choose a connection` });
        if (!d.sql?.trim()) errors.push({ nodeId: n.id, message: `${d.label}: SQL is empty` });
        for (const [k, v] of Object.entries(d.params ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push({ nodeId: n.id, message: `${d.label}: invalid variable name "${k}"` });
          if (!String(v ?? '').trim()) errors.push({ nodeId: n.id, message: `${d.label}: variable :${k} has no value expression` });
        }
        const st = d.errorStatus ?? 502;
        if (!Number.isInteger(st) || st < 100 || st > 599) errors.push({ nodeId: n.id, message: `${d.label}: error status must be 100-599` });
        break;
      }
      case 'response':
        if (!ins.length) errors.push({ nodeId: n.id, message: 'Response needs at least one input to aggregate' });
        if (!Number.isInteger(n.data.status) || n.data.status < 100 || n.data.status > 599) errors.push({ nodeId: n.id, message: 'Response status must be 100-599' });
        break;
    }
  }
  if (errors.length) return fail();

  // ---- naming ---------------------------------------------------------------
  const names = new NameAllocator();
  const primary = new Map<string, string>();
  for (const n of order) primary.set(n.id, n.type === 'trigger' ? 'request' : names.take(upperSnake(n.data.label)));
  const helper = (n: FlowNode, suffix: string) => {
    const name = names.take(`${primary.get(n.id)}__${suffix}`);
    nodeMap[n.id].push(name);
    return name;
  };

  // ---- emit -----------------------------------------------------------------
  const out: DatakitNode[] = [];
  const vault: Record<string, string> = {};
  const vaultKey = new Map<string, string>();
  /** Names a condition branch may skip; for database nodes only the request + call, so their gate still runs. */
  const gateNames = new Map<string, string[]>();

  /** jq `inputs` map plus a prelude that regroups trigger inputs under their alias. */
  const jqInputs = (ins: DataInput[]) => {
    const inputs: Record<string, string> = {};
    const regroup: string[] = [];
    for (const { alias, source } of ins) {
      switch (source.type) {
        case 'trigger': {
          const parts = source.data.method === 'GET' ? ['query', 'headers'] : ['query', 'headers', 'body'];
          for (const p of parts) inputs[`${alias}__${p}`] = `request.${p}`;
          regroup.push(`${alias}: {${parts.map((p) => `${p}: .${alias}__${p}`).join(', ')}}`);
          break;
        }
        case 'http': inputs[alias] = `${primary.get(source.id)}.body`; break;
        case 'secret': inputs[alias] = `vault.${vaultKey.get(source.id)}`; break;
        default: inputs[alias] = primary.get(source.id)!;
      }
    }
    const prelude = regroup.length
      ? `(. as $in | ($in | with_entries(select(.key | test("__(query|headers|body)$") | not))) + {${regroup.join(', ')}}) | `
      : '';
    return { inputs, wrap: (expr: string) => `${prelude}(${expr.trim()})` };
  };

  for (const n of order) {
    const name = primary.get(n.id)!;
    nodeMap[n.id] = n.type === 'trigger' || n.type === 'secret' ? [] : [name];
    const ins = dataIn.get(n.id)!;

    switch (n.type) {
      case 'trigger':
        break;
      case 'secret': {
        const key = names.take(lowerSnake(n.data.label)).toLowerCase();
        vaultKey.set(n.id, key);
        vault[key] = `{vault://env/${n.data.env.toLowerCase().replace(/_/g, '-')}}`;
        break;
      }
      case 'static':
        out.push({ name, type: 'static', values: n.data.values ?? {} });
        break;
      case 'transform': {
        const { inputs, wrap } = jqInputs(ins);
        out.push({ name, type: 'jq', inputs, jq: wrap(n.data.expr) });
        break;
      }
      case 'condition': {
        const { inputs, wrap } = jqInputs(ins);
        out.push({ name, type: 'jq', inputs, jq: `${wrap(n.data.expr)} | (. != false and . != null)` });
        // branch is emitted after all nodes are named; reserve its name now
        nodeMap[n.id].push(names.take(`${name}__BRANCH`));
        break;
      }
      case 'xml': {
        const src = ins[0].source;
        const ref = src.type === 'trigger' ? 'request.body' : src.type === 'http' ? `${primary.get(src.id)}.body` : primary.get(src.id)!;
        out.push({ name, type: 'xml_to_json', input: ref, attributes_name_prefix: '@' });
        break;
      }
      case 'http':
        out.push(...compileHttp(n, name, ins));
        break;
      case 'database':
        out.push(...compileDatabase(n, name, ins));
        break;
      case 'response': {
        const { inputs, wrap } = jqInputs(ins);
        const body = helper(n, 'BODY');
        out.push({ name: body, type: 'jq', inputs, jq: wrap(n.data.expr?.trim() || '.') });
        out.push({ name, type: 'exit', status: n.data.status, inputs: { body } });
        break;
      }
    }
  }

  /**
   * PARAMS (jq over inputs) -> REQ -> CALL (POST db-access /query) -> OK -> GATE.
   * Only the connection name travels through Kong; db-access resolves the
   * connection string from the local Vault.
   * db-access answers 200 with {ok:false,...} on errors. The gate runs the result
   * node on success, or the error exit, which ends the flow with the database
   * message. (A DataKit node may belong to one branch only, so the gate owns just
   * this node's own result and error path.)
   */
  function compileDatabase(n: FlowNode & { type: 'database' }, name: string, ins: DataInput[]): DatakitNode[] {
    const d: DatabaseData = n.data;
    const { inputs, wrap } = jqInputs(ins);
    const params = Object.entries(d.params ?? {}).map(([k, v]) => `${JSON.stringify(k)}: (${v.trim()})`).join(', ');
    const paramsNode = helper(n, 'PARAMS');
    const req = helper(n, 'REQ');
    const call = helper(n, 'CALL');
    const ok = helper(n, 'OK');
    const gate = helper(n, 'GATE');
    const errBody = names.take(`${name}__ERR_BODY`);
    const errExit = names.take(`${name}__ERR`);
    failPaths[n.id] = [errBody, errExit];
    gateNames.set(n.id, [paramsNode, req, call]);
    const res = `${call}.body`;
    return [
      { name: paramsNode, type: 'jq', inputs, jq: wrap(`{${params}}`) },
      {
        name: req, type: 'jq', inputs: { p: paramsNode },
        jq: `{connection: ${JSON.stringify(d.connection)}, sql: ${JSON.stringify(d.sql)}, params: .p}`,
      },
      // Fail fast if db-access itself is unreachable (its statement timeout is 10s).
      { name: call, type: 'call', method: 'POST', url: `${dbAccessUrl}/query`, timeout: 15000, inputs: { body: req } },
      // A skipped query (condition gate) arrives as null and counts as OK so the flow continues.
      { name: ok, type: 'jq', inputs: { r: res }, jq: '.r == null or .r.ok == true' },
      { name: gate, type: 'branch', input: ok, then: [name], else: [errBody, errExit] },
      // Error path first so it is scheduled before anything downstream of the result.
      {
        name: errBody, type: 'jq', inputs: { r: res },
        jq: `{error: "database query failed", node: ${JSON.stringify(d.label)}, message: .r.error, code: .r.code, detail: .r.detail, hint: .r.hint}`,
      },
      { name: errExit, type: 'exit', status: d.errorStatus ?? 502, inputs: { body: errBody } },
      { name, type: 'jq', inputs: { r: res }, jq: 'if .r == null then null else {rows: .r.rows, row_count: .r.rowCount, fields: .r.fields, truncated: .r.truncated} end' },
    ];
  }

  function compileHttp(n: FlowNode & { type: 'http' }, name: string, ins: DataInput[]): DatakitNode[] {
    const d: HttpJobData = n.data;
    const nodesOut: DatakitNode[] = [];
    const call: DatakitNode = { name, type: 'call', method: d.method, url: templateFallback(d.url) };
    const callInputs: Record<string, string> = {};
    if (ins.length) {
      const { inputs, wrap } = jqInputs(ins);
      const parts: [keyof HttpJobData, string | undefined][] = [
        ['url', hasPlaceholders(d.url) ? templateToJq(d.url) : undefined],
        ['query', d.query?.trim() || undefined],
        ['headers', d.headers?.trim() || undefined],
        ['body', d.body?.trim() || undefined],
      ];
      for (const [field, expr] of parts) {
        if (!expr) continue;
        const h = helper(n, String(field).toUpperCase());
        nodesOut.push({ name: h, type: 'jq', inputs, jq: wrap(expr) });
        callInputs[field] = h;
      }
      // Inputs connected but nothing templated: still wait for them so the
      // drawn edge keeps its "run after" meaning.
      if (!Object.keys(callInputs).length) {
        const h = helper(n, 'AFTER');
        nodesOut.push({ name: h, type: 'jq', inputs, jq: '{}' });
        callInputs.headers = h;
      }
    }
    if (Object.keys(callInputs).length) call.inputs = callInputs;
    nodesOut.push(call);
    return nodesOut;
  }

  // ---- branches ---------------------------------------------------------------
  for (const [condId, c] of control) {
    const lists = { then: gated(c.then), else: gated(c.else) };
    const branch: DatakitNode = { name: nodeMap[condId][1], type: 'branch', input: primary.get(condId) };
    if (lists.then.length) branch.then = lists.then;
    if (lists.else.length) branch.else = lists.else;
    const at = out.findIndex((x) => x.name === primary.get(condId));
    out.splice(at + 1, 0, branch);
  }

  /** Direct targets plus every downstream node fed only by gated nodes. */
  function gated(targets: string[]): string[] {
    const set = new Set(targets);
    for (const n of order) {
      if (set.has(n.id) || n.type === 'response') continue;
      const ps = [...parents.get(n.id)!];
      if (ps.length && ps.every((p) => set.has(p))) set.add(n.id);
    }
    return order.filter((n) => set.has(n.id)).flatMap((n) => gateNames.get(n.id) ?? nodeMap[n.id]);
  }

  const config: DatakitConfig = { debug: flow.debug ?? true, nodes: out };
  if (Object.keys(vault).length) config.resources = { vault };
  const trigger = triggers[0] as FlowNode & { type: 'trigger' };
  return { ok: true, errors, config, nodeMap, failPaths, route: { path: `/flows/${flow.slug}`, method: trigger.data.method } };
}

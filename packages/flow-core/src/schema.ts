// Flow graph model shared by the web designer and the API. The shape mirrors
// React Flow (nodes/edges with `type` and `data`) so the UI can persist it as-is.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface TriggerData { label: string; method: HttpMethod }
export interface HttpJobData {
  label: string;
  method: HttpMethod;
  /** Static URL, or a template with `{{ jq }}` placeholders evaluated over the node's inputs. */
  url: string;
  /** Optional jq expressions (over the node's inputs) producing query / headers / body objects. */
  query?: string;
  headers?: string;
  body?: string;
}
export interface TransformData { label: string; expr: string }
export interface ConditionData { label: string; expr: string }
export interface StaticData { label: string; values: Record<string, unknown> }
export interface SecretData { label: string; env: string }
export interface XmlData { label: string }
export interface ResponseData { label: string; status: number; expr?: string }
export interface DatabaseData {
  label: string;
  /** Connection name configured on db-access (DB_CONN_<NAME>). */
  connection: string;
  /** SQL with `:name` variables; values are always bound as parameters. */
  sql: string;
  /** Variable name -> jq expression evaluated over the node's inputs. */
  params?: Record<string, string>;
  /** Status returned to the caller when the query fails (default 502). */
  errorStatus?: number;
}

export interface NodeDataByKind {
  trigger: TriggerData;
  http: HttpJobData;
  transform: TransformData;
  condition: ConditionData;
  static: StaticData;
  secret: SecretData;
  xml: XmlData;
  response: ResponseData;
  database: DatabaseData;
}
export type NodeKind = keyof NodeDataByKind;
export const NODE_KINDS = ['trigger', 'http', 'database', 'transform', 'condition', 'static', 'secret', 'xml', 'response'] as const satisfies readonly NodeKind[];

export type FlowNode = {
  [K in NodeKind]: { id: string; type: K; position: { x: number; y: number }; data: NodeDataByKind[K] };
}[NodeKind];

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** `then` / `else` when the source is a condition node; absent for data edges. */
  sourceHandle?: string | null;
  data?: { alias?: string };
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Flow {
  id?: string;
  name: string;
  slug: string;
  debug?: boolean;
  graph: FlowGraph;
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

import { useEffect, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { HTTP_METHODS, lowerSnake, type FlowNode } from '@ipaas/flow-core';
import { KINDS } from '../catalog';
import { DatabaseFields } from './DatabaseFields';
import { EdiSendFields } from './EdiSendFields';

interface Props {
  node?: FlowNode;
  edge?: Edge;
  nodes: Node[];
  edges: Edge[];
  slug: string;
  onNode: (id: string, data: Record<string, unknown>) => void;
  onEdge: (id: string, alias: string) => void;
  onDelete: () => void;
}

export function Inspector({ node, edge, nodes, edges, slug, onNode, onEdge, onDelete }: Props) {
  if (edge) return <EdgeInspector edge={edge} nodes={nodes} onEdge={onEdge} onDelete={onDelete} />;
  if (!node) {
    return (
      <aside className="inspector">
        <h3>Inspector</h3>
        <p className="muted">Select a node or edge to edit it.</p>
        <div className="help">
          <p><b>Edges carry data.</b> The source's output is available in the target's jq as <code>.alias</code>.</p>
          <p>Jobs with no path between them <b>run in parallel</b>. Chain them to run in sequence.</p>
          <p>The Trigger exposes <code>.alias.query</code>, <code>.alias.headers</code> and, for non-GET, <code>.alias.body</code>.</p>
          <p>Condition <b>then/else</b> edges only gate which jobs run. They carry no data.</p>
        </div>
      </aside>
    );
  }
  const info = KINDS[node.type];
  const inputs = edges
    .filter((e) => e.target === node.id && !e.sourceHandle)
    .map((e) => (e.data as { alias?: string } | undefined)?.alias || lowerSnake(String(nodes.find((n) => n.id === e.source)?.data.label ?? '')));
  const set = (patch: Record<string, unknown>) => onNode(node.id, { ...node.data, ...patch });
  const d = node.data as any;

  return (
    <aside className="inspector">
      <h3><span className="glyph" style={{ color: info.color }}>{info.glyph}</span> {info.title}</h3>
      <p className="muted small">{info.description}</p>
      <Field label="Label"><input value={d.label} onChange={(e) => set({ label: e.target.value })} /></Field>
      {info.inputs && (
        <div className="inputs-hint">
          Inputs: {inputs.length ? inputs.map((a) => <code key={a}>.{a}</code>) : <span className="muted">none connected</span>}
        </div>
      )}

      {node.type === 'trigger' && (
        <>
          <Field label="Method"><MethodSelect value={d.method} onChange={(method) => set({ method })} /></Field>
          <p className="muted small">Endpoint: <code>/flows/{slug}</code></p>
        </>
      )}

      {node.type === 'http' && (
        <>
          <Field label="Method"><MethodSelect value={d.method} onChange={(method) => set({ method })} /></Field>
          <Field label="URL" hint="Use {{ jq }} placeholders (URI-encoded) or {{{ jq }}} (raw), e.g. http://mocks:4010/users/{{ .req.query.id }}">
            <input value={d.url} onChange={(e) => set({ url: e.target.value })} className="mono" />
          </Field>
          <Jq label="Query (jq → object)" value={d.query} onChange={(query) => set({ query })} placeholder="{city: .user.city}" />
          <Jq label="Headers (jq → object)" value={d.headers} onChange={(headers) => set({ headers })} placeholder='{"x-api-key": .key}' />
          {d.method !== 'GET' && <Jq label="Body (jq)" value={d.body} onChange={(body) => set({ body })} placeholder="{order: .req.body}" />}
        </>
      )}

      {node.type === 'database' && <DatabaseFields key={node.id} data={d} inputs={inputs} onChange={set} />}
      {node.type === 'edi_send' && <EdiSendFields key={node.id} data={d} inputs={inputs} onChange={set} />}

      {(node.type === 'transform' || node.type === 'condition') && (
        <Jq label={node.type === 'condition' ? 'Condition (jq → boolean)' : 'jq expression'} value={d.expr} onChange={(expr) => set({ expr })} rows={6} />
      )}

      {node.type === 'static' && <JsonField label="Values (JSON object)" value={d.values} onChange={(values) => set({ values })} />}

      {node.type === 'secret' && (
        <Field label="Env var on the data plane" hint="Put it in secrets.env, e.g. IPAAS_SECRET_API_KEY=…">
          <input className="mono" value={d.env} onChange={(e) => set({ env: e.target.value.toUpperCase() })} />
        </Field>
      )}

      {node.type === 'response' && (
        <>
          <Field label="Status"><input type="number" value={d.status} onChange={(e) => set({ status: Number(e.target.value) })} /></Field>
          <Jq label="Aggregate (jq)" value={d.expr} onChange={(expr) => set({ expr })} rows={8} placeholder=". (all inputs keyed by alias)" />
        </>
      )}

      {!info.singleton && <button className="ghost danger block" onClick={onDelete}>Delete node</button>}
    </aside>
  );
}

function EdgeInspector({ edge, nodes, onEdge, onDelete }: { edge: Edge; nodes: Node[]; onEdge: Props['onEdge']; onDelete: () => void }) {
  const src = nodes.find((n) => n.id === edge.source);
  const dst = nodes.find((n) => n.id === edge.target);
  const alias = (edge.data as { alias?: string } | undefined)?.alias ?? '';
  return (
    <aside className="inspector">
      <h3>Edge</h3>
      <p className="muted small">{String(src?.data.label)} → {String(dst?.data.label)}</p>
      {edge.sourceHandle ? (
        <p>This is a <b>{edge.sourceHandle}</b> gate. <i>{String(dst?.data.label)}</i> runs only when the condition is {edge.sourceHandle === 'then' ? 'true' : 'false'}. Skipped jobs pass <code>null</code> downstream.</p>
      ) : (
        <Field label="Input alias" hint={`Available in the target's jq as .${alias || lowerSnake(String(src?.data.label ?? ''))}`}>
          <input className="mono" value={alias} placeholder={lowerSnake(String(src?.data.label ?? ''))} onChange={(e) => onEdge(edge.id, e.target.value)} />
        </Field>
      )}
      <button className="ghost danger block" onClick={onDelete}>Delete edge</button>
    </aside>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function MethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}>{HTTP_METHODS.map((m) => <option key={m}>{m}</option>)}</select>;
}

function Jq({ label, value, onChange, rows = 3, placeholder }: { label: string; value?: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <Field label={label}>
      <textarea className="mono" rows={rows} spellCheck={false} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(value ?? {}, null, 2)), [value]);
  return (
    <Field label={label} hint={err ?? undefined}>
      <textarea
        className="mono" rows={6} spellCheck={false} value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const v = JSON.parse(text);
            if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Must be a JSON object');
            setErr(null);
            onChange(v);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      />
    </Field>
  );
}

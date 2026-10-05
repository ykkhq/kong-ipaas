import { useState } from 'react';
import type { CompileResponse, FlowRecord, TestResponse } from '../api';
import type { FlowNode, NodeTrace } from '@ipaas/flow-core';

interface Props {
  flow: FlowRecord;
  nodes: FlowNode[];
  compiled: CompileResponse | null;
  test: TestResponse | null;
  testing: boolean;
  onRun: (req: { query: Record<string, string>; headers: Record<string, string>; body?: unknown; trace: boolean }) => void;
  onSelect: (id: string) => void;
}

export function BottomPanel({ flow, nodes, compiled, test, testing, onRun, onSelect }: Props) {
  const [tab, setTab] = useState<'test' | 'compiled'>('test');
  const [open, setOpen] = useState(true);
  return (
    <section className={`bottom ${open ? '' : 'collapsed'}`}>
      <div className="tabs">
        <button className={tab === 'test' ? 'active' : ''} onClick={() => { setTab('test'); setOpen(true); }}>Test run</button>
        <button className={tab === 'compiled' ? 'active' : ''} onClick={() => { setTab('compiled'); setOpen(true); }}>
          Compiled DataKit {compiled && !compiled.ok && <span className="count">{compiled.errors.length}</span>}
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={() => setOpen(!open)}>{open ? '▾' : '▴'}</button>
      </div>
      {open && (tab === 'compiled'
        ? <Compiled compiled={compiled} onSelect={onSelect} />
        : <TestTab flow={flow} nodes={nodes} test={test} testing={testing} onRun={onRun} onSelect={onSelect} />)}
    </section>
  );
}

function Compiled({ compiled, onSelect }: { compiled: CompileResponse | null; onSelect: (id: string) => void }) {
  if (!compiled) return <div className="pane muted">Compiling…</div>;
  return (
    <div className="pane split">
      <div className="col">
        {compiled.ok ? <div className="banner ok">Valid. Route <code>{compiled.route?.method} {compiled.route?.path}</code></div> : (
          <ul className="errors">
            {compiled.errors.map((e, i) => (
              <li key={i} onClick={() => e.nodeId && onSelect(e.nodeId)} className={e.nodeId ? 'link' : ''}>{e.message}</li>
            ))}
          </ul>
        )}
        <p className="muted small">Each flow deploys to Konnect as a Service, a Route and a <code>datakit</code> plugin on that route.</p>
      </div>
      <pre className="code col grow">{compiled.yaml ?? '# fix the errors to see the generated config'}</pre>
    </div>
  );
}

function TestTab({ flow, nodes, test, testing, onRun, onSelect }: Omit<Props, 'compiled'>) {
  const trigger = nodes.find((n) => n.type === 'trigger');
  const method = trigger?.type === 'trigger' ? trigger.data.method : 'GET';
  const [query, setQuery] = useState('id=1');
  const [headers, setHeaders] = useState('');
  const [body, setBody] = useState('{\n  \n}');
  const [trace, setTrace] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    try {
      setErr(null);
      onRun({
        query: parseKv(query),
        headers: parseKv(headers, ':'),
        body: method === 'GET' || !body.trim() ? undefined : JSON.parse(body),
        trace,
      });
    } catch (e) {
      setErr(`Body: ${(e as Error).message}`);
    }
  };

  const live = flow.deployed_version != null;
  return (
    <div className="pane split">
      <div className="col request">
        <div className="row">
          <code className="method">{method}</code>
          <code className="grow ellipsis">{flow.endpoint}{query.trim() ? `?${new URLSearchParams(parseKv(query))}` : ''}</code>
        </div>
        <label className="field"><span>Query (one key=value per line)</span>
          <textarea className="mono" rows={2} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <label className="field"><span>Headers (one name: value per line)</span>
          <textarea className="mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} /></label>
        {method !== 'GET' && (
          <label className="field"><span>JSON body</span>
            <textarea className="mono" rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        )}
        <div className="row">
          <label className="check"><input type="checkbox" checked={trace} onChange={(e) => setTrace(e.target.checked)} /> Trace nodes</label>
          <span className="spacer" />
          <button className="primary" disabled={testing || !live} onClick={run} title={live ? '' : 'Deploy the flow first'}>{testing ? 'Running…' : 'Send'}</button>
        </div>
        {!live && <p className="muted small">Deploy the flow to test it on the data plane.</p>}
        {flow.status === 'outdated' && <p className="warn small">You have changes that aren't deployed. The test runs the live version (v{flow.deployed_version}).</p>}
        {err && <div className="banner error">{err}</div>}
        <p className="muted small">curl: <code className="select">curl {method !== 'GET' ? `-X ${method} -H 'content-type: application/json' -d '…' ` : ''}'{flow.endpoint}{query.trim() ? `?${new URLSearchParams(parseKv(query))}` : ''}'</code></p>
      </div>
      <div className="col grow result">
        {!test ? <p className="muted">Send a request to see the aggregated result and per-node timing.</p> : (
          <>
            <div className="row">
              <span className={`badge ${test.status < 400 ? 'live' : 'error'}`}>HTTP {test.status}</span>
              <span className="muted">{test.latencyMs} ms total</span>
              {test.trace && <span className="muted">· plan {test.trace.status}</span>}
            </div>
            <div className="split inner">
              <pre className="code grow">{JSON.stringify(test.body, null, 2)}</pre>
              {test.trace && <Timeline nodes={nodes} trace={test.trace.byUiNode} total={test.trace.totalMs} onSelect={onSelect} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Timeline({ nodes, trace, total, onSelect }: { nodes: FlowNode[]; trace: Record<string, NodeTrace>; total: number; onSelect: (id: string) => void }) {
  const rows = nodes
    .filter((n) => trace[n.id])
    .map((n) => ({ n, t: trace[n.id] }))
    .sort((a, b) => (a.t.startMs ?? 0) - (b.t.startMs ?? 0));
  const scale = (v: number) => `${(100 * v) / Math.max(total, 1)}%`;
  return (
    <div className="timeline">
      {rows.map(({ n, t }) => {
        const start = t.startMs ?? 0;
        const end = Math.max(t.endMs ?? start, start);
        return (
          <div key={n.id} className="tl-row" onClick={() => onSelect(n.id)} title={t.error ? JSON.stringify(t.error) : undefined}>
            <span className="tl-name">{n.data.label}</span>
            <span className="tl-track">
              <span className={`tl-bar ${t.state}`} style={{ left: scale(start), width: `max(3px, ${scale(end - start)})` }} />
            </span>
            <span className="tl-ms">{t.state === 'complete' ? `${Math.round(end - start)}ms` : t.state}</span>
          </div>
        );
      })}
    </div>
  );
}

function parseKv(text: string, sep = '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

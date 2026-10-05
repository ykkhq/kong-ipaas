import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { FlowEdge, FlowGraph, FlowNode, NodeKind } from '@ipaas/flow-core';
import { lowerSnake } from '@ipaas/flow-core';
import { api, type CompileResponse, type FlowRecord, type PlatformStatus, type TestResponse } from '../api';
import { KINDS, PALETTE, newNode } from '../catalog';
import { BottomPanel } from './BottomPanel';
import { nodeTypes, OverlayContext } from './FlowNodes';
import { Inspector } from './Inspector';
import { PlatformPill } from './FlowList';
import { StatusBadge } from './StatusBadge';

export function Designer({ flowId }: { flowId: string }) {
  return (
    <ReactFlowProvider>
      <DesignerInner flowId={flowId} />
    </ReactFlowProvider>
  );
}

function toRfEdge(e: FlowEdge): Edge {
  const gate = e.sourceHandle === 'then' || e.sourceHandle === 'else' ? e.sourceHandle : null;
  return {
    ...e,
    sourceHandle: gate,
    label: gate ?? e.data?.alias,
    className: gate ? `gate ${gate}` : 'data',
    animated: !gate,
  };
}

function DesignerInner({ flowId }: { flowId: string }) {
  const rf = useReactFlow();
  const [flow, setFlow] = useState<FlowRecord | null>(null);
  const [meta, setMeta] = useState({ name: '', slug: '' });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selection, setSelection] = useState<{ node?: string; edge?: string }>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [compiled, setCompiled] = useState<CompileResponse | null>(null);
  const [test, setTest] = useState<TestResponse | null>(null);
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    api.get(flowId).then((f) => {
      setFlow(f);
      setMeta({ name: f.name, slug: f.slug });
      setNodes(f.graph.nodes as unknown as Node[]);
      setEdges(f.graph.edges.map(toRfEdge));
      loaded.current = true;
      setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
    }).catch((e) => setMessage({ kind: 'error', text: e.message }));
    api.status().then(setStatus).catch(() => undefined);
  }, [flowId]);

  const graph = useMemo<FlowGraph>(() => ({
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data }) as unknown as FlowNode),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, data: e.data as FlowEdge['data'] })),
  }), [nodes, edges]);

  // Structural signature: positions/selection changes don't trigger recompiles.
  const signature = useMemo(() => JSON.stringify({ meta, n: graph.nodes.map((n) => [n.id, n.type, n.data]), e: graph.edges }), [graph, meta]);
  const lastSig = useRef<string>('');
  useEffect(() => {
    if (!loaded.current) return;
    if (lastSig.current && lastSig.current !== signature) setDirty(true);
    lastSig.current = signature;
    const t = setTimeout(() => {
      api.compile({ name: meta.name || 'flow', slug: meta.slug || 'x', debug: flow?.debug ?? true, graph }).then(setCompiled).catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [signature]);

  const errorsByNode = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const e of compiled?.errors ?? []) if (e.nodeId) (m[e.nodeId] ??= []).push(e.message);
    return m;
  }, [compiled]);
  const overlay = useMemo(() => ({ trace: test?.trace?.byUiNode ?? {}, errors: errorsByNode }), [test, errorsByNode]);

  const onConnect = useCallback((c: Connection) => {
    const src = nodes.find((n) => n.id === c.source);
    const gate = c.sourceHandle === 'then' || c.sourceHandle === 'else' ? c.sourceHandle : null;
    const alias = gate ? undefined : lowerSnake(String(src?.data.label ?? 'input'));
    setEdges((es) => addEdge(toRfEdge({ id: `e-${Date.now().toString(36)}`, source: c.source!, target: c.target!, sourceHandle: gate, data: alias ? { alias } : undefined }), es));
  }, [nodes]);

  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (c.source === c.target) return false;
    const dst = nodes.find((n) => n.id === c.target);
    return Boolean(dst && KINDS[dst.type as NodeKind].inputs);
  }, [nodes]);

  const addKind = (kind: NodeKind, position?: { x: number; y: number }) => {
    const info = KINDS[kind];
    if (info.singleton && nodes.some((n) => n.type === kind)) {
      setMessage({ kind: 'warn', text: `A flow can only have one ${info.title}` });
      return;
    }
    const center = position ?? rf.screenToFlowPosition({ x: window.innerWidth / 2 - 150, y: window.innerHeight / 3 });
    const n = newNode(kind, center) as unknown as Node;
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, selected: true }]);
    setSelection({ node: n.id });
  };

  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    const kind = ev.dataTransfer.getData('application/x-node-kind') as NodeKind;
    if (kind) addKind(kind, rf.screenToFlowPosition({ x: ev.clientX - 90, y: ev.clientY - 30 }));
  };

  const updateNode = (id: string, data: Record<string, unknown>) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data } : n)));
  const updateEdge = (id: string, alias: string) =>
    setEdges((es) => es.map((e) => (e.id === id ? { ...e, data: { alias }, label: alias } : e)));
  const deleteSelected = () => {
    if (selection.edge) setEdges((es) => es.filter((e) => e.id !== selection.edge));
    if (selection.node) {
      setNodes((ns) => ns.filter((n) => n.id !== selection.node));
      setEdges((es) => es.filter((e) => e.source !== selection.node && e.target !== selection.node));
    }
    setSelection({});
  };

  const layout = () => {
    const g = new dagre.graphlib.Graph().setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90 }).setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) g.setNode(n.id, { width: n.measured?.width ?? 220, height: n.measured?.height ?? 70 });
    for (const e of edges) g.setEdge(e.source, e.target);
    dagre.layout(g);
    setNodes((ns) => ns.map((n) => {
      const p = g.node(n.id);
      return { ...n, position: { x: p.x - (n.measured?.width ?? 220) / 2, y: p.y - (n.measured?.height ?? 70) / 2 } };
    }));
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 50);
  };

  const save = async (): Promise<FlowRecord | null> => {
    if (!flow) return null;
    setBusy('save');
    try {
      const f = await api.update(flow.id, { name: meta.name, slug: meta.slug, debug: flow.debug, graph });
      setFlow(f);
      setDirty(false);
      setMessage({ kind: 'ok', text: `Saved v${f.version}` });
      return f;
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const deploy = async () => {
    if (!flow) return;
    const saved = dirty ? await save() : flow;
    if (!saved) return;
    setBusy('deploy');
    setMessage({ kind: 'warn', text: 'Pushing to Konnect and waiting for the data plane to sync…' });
    try {
      const r = await api.deploy(saved.id);
      setFlow(r.flow);
      setMessage(r.synced
        ? { kind: 'ok', text: `Live: ${r.flow.endpoint}` }
        : { kind: 'warn', text: r.flow.last_error ?? 'Deployed. Data plane sync not confirmed yet.' });
    } catch (e: any) {
      if (e.data?.flow) setFlow(e.data.flow);
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const undeploy = async () => {
    if (!flow) return;
    setBusy('undeploy');
    try {
      const r = await api.undeploy(flow.id);
      setFlow(r.flow);
      setMessage({ kind: 'ok', text: 'Removed from the gateway' });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const run = async (req: Parameters<typeof api.test>[1]) => {
    if (!flow) return;
    setBusy('test');
    try {
      setTest(await api.test(flow.id, req));
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const select = (id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setSelection({ node: id });
  };

  if (!flow) return <div className="page"><p className="muted pad">{message?.text ?? 'Loading…'}</p></div>;
  const selNode = graph.nodes.find((n) => n.id === selection.node);
  const selEdge = edges.find((e) => e.id === selection.edge);

  return (
    <div className="page designer">
      <header className="topbar">
        <a href="#/" className="brand"><img src="/favicon.svg" alt="" /> Flows</a>
        <span className="sep">/</span>
        <input className="title-input" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
        <span className="slug">/flows/<input value={meta.slug} onChange={(e) => setMeta({ ...meta, slug: e.target.value.toLowerCase() })} /></span>
        <StatusBadge status={flow.status} title={flow.last_error ?? undefined} />
        <span className="spacer" />
        <PlatformPill status={status} />
        <button className="ghost" onClick={layout}>Auto-layout</button>
        <button onClick={save} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
        {flow.deployed_version != null && <button className="ghost" onClick={undeploy} disabled={!!busy}>{busy === 'undeploy' ? 'Removing…' : 'Undeploy'}</button>}
        <button className="primary" onClick={deploy} disabled={!!busy || (compiled ? !compiled.ok : false)}>{busy === 'deploy' ? 'Deploying…' : 'Deploy'}</button>
      </header>
      {message && <div className={`banner ${message.kind} floating`} onClick={() => setMessage(null)}>{message.text}</div>}
      <div className="workspace">
        <aside className="palette">
          <h3>Nodes</h3>
          {PALETTE.map((k) => (
            <div
              key={k} className="palette-item" draggable
              onDragStart={(e) => e.dataTransfer.setData('application/x-node-kind', k)}
              onDoubleClick={() => addKind(k)}
              title={`${KINDS[k].description}. Drag onto the canvas or double-click.`}
              style={{ ['--accent' as string]: KINDS[k].color }}
            >
              <span className="glyph">{KINDS[k].glyph}</span>
              <span><b>{KINDS[k].title}</b><small>{KINDS[k].description}</small></span>
            </div>
          ))}
        </aside>
        <div className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <OverlayContext.Provider value={overlay}>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, n) => setSelection({ node: n.id })}
              onEdgeClick={(_, e) => setSelection({ edge: e.id })}
              onPaneClick={() => setSelection({})}
              deleteKeyCode={['Backspace', 'Delete']}
              onNodesDelete={(ds) => ds.some((d) => KINDS[d.type as NodeKind].singleton) && setMessage({ kind: 'warn', text: 'Trigger and Response are required. Add them back from the palette.' })}
              fitView
            >
              <Background gap={20} />
              <Controls />
              <MiniMap pannable zoomable style={{ width: 150, height: 96 }} maskColor="#0b102099" bgColor="#111831" nodeColor={(n) => KINDS[n.type as NodeKind]?.color ?? '#999'} />
            </ReactFlow>
          </OverlayContext.Provider>
        </div>
        <Inspector
          node={selNode} edge={selEdge} nodes={nodes} edges={edges} slug={meta.slug}
          onNode={updateNode} onEdge={updateEdge} onDelete={deleteSelected}
        />
      </div>
      <BottomPanel flow={flow} nodes={graph.nodes} compiled={compiled} test={test} testing={busy === 'test'} onRun={run} onSelect={select} />
    </div>
  );
}

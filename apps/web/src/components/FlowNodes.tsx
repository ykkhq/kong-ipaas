import { createContext, memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode, NodeKind, NodeTrace } from '@ipaas/flow-core';
import { KINDS } from '../catalog';

/** Per designer-node overlays: last test-run trace and compile errors. */
export const OverlayContext = createContext<{ trace: Record<string, NodeTrace>; errors: Record<string, string[]> }>({ trace: {}, errors: {} });

function summary(n: FlowNode): string {
  switch (n.type) {
    case 'trigger': return n.data.method;
    case 'http': return `${n.data.method} ${n.data.url}`;
    case 'edi_send': return `${n.data.partner || '(no partner)'} · ${n.data.contentType || 'application/octet-stream'}`;
    case 'database': return `${n.data.connection} · ${n.data.sql.replace(/\s+/g, ' ')}`;
    case 'transform':
    case 'condition': return n.data.expr;
    case 'static': return Object.keys(n.data.values ?? {}).join(', ');
    case 'secret': return `env ${n.data.env}`;
    case 'xml': return 'xml_to_json';
    case 'response': return `${n.data.status} · ${n.data.expr || '.'}`;
  }
}

const BaseNode = memo(function BaseNode(props: NodeProps) {
  const node = { id: props.id, type: props.type, data: props.data } as unknown as FlowNode;
  const info = KINDS[node.type as NodeKind];
  const { trace, errors } = useContext(OverlayContext);
  const t = trace[props.id];
  const errs = errors[props.id];
  const cls = ['fnode', `kind-${node.type}`, props.selected ? 'selected' : '', t ? `state-${t.state}` : '', errs ? 'has-error' : ''].join(' ');
  return (
    <div className={cls} style={{ ['--accent' as string]: info.color }} title={errs?.join('\n')}>
      {info.inputs && <Handle type="target" position={Position.Left} />}
      <div className="fnode-head">
        <span className="glyph">{info.glyph}</span>
        <span className="fnode-title">{node.data.label}</span>
        {t && <span className={`state-chip ${t.state}`}>{stateText(t)}</span>}
      </div>
      <div className="fnode-body">{summary(node)}</div>
      {info.output && <Handle type="source" position={Position.Right} />}
      {node.type === 'condition' && (
        <>
          <Handle id="then" type="source" position={Position.Right} style={{ top: '35%' }} className="h-then" />
          <Handle id="else" type="source" position={Position.Right} style={{ top: '75%' }} className="h-else" />
          <span className="handle-label then">then</span>
          <span className="handle-label else">else</span>
        </>
      )}
    </div>
  );
});

function stateText(t: NodeTrace): string {
  if (t.state === 'complete' && t.startMs != null && t.endMs != null) return `${Math.round(t.endMs - t.startMs)} ms`;
  return t.state;
}

export const nodeTypes = Object.fromEntries(Object.keys(KINDS).map((k) => [k, BaseNode]));

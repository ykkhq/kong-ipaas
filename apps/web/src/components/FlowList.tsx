import { useEffect, useState } from 'react';
import { api, type FlowRecord, type PlatformStatus } from '../api';
import { blankGraph } from '../catalog';
import { StatusBadge } from './StatusBadge';

export function FlowList() {
  const [flows, setFlows] = useState<FlowRecord[] | null>(null);
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => api.list().then(setFlows).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
    api.status().then(setStatus).catch(() => undefined);
  }, []);

  const create = async () => {
    const name = prompt('Flow name', 'My flow');
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flow';
    try {
      const f = await api.create({ name, slug, debug: true, graph: blankGraph() });
      window.location.hash = `/flows/${f.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (f: FlowRecord, what: 'deploy' | 'undeploy' | 'delete') => {
    if (what === 'delete' && !confirm(`Delete "${f.name}"? Deployed entities are removed from Konnect too.`)) return;
    setBusy(f.id);
    setError(null);
    try {
      if (what === 'deploy') await api.deploy(f.id);
      else if (what === 'undeploy') await api.undeploy(f.id);
      else await api.remove(f.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><img src="/favicon.svg" alt="" /> Flow Builder</div>
        <PlatformPill status={status} />
      </header>
      <main className="list">
        <div className="list-head">
          <div>
            <h1>Flows</h1>
            <p className="muted">Each flow is one endpoint on the Kong data plane. A request runs its jobs through DataKit and returns the aggregated result.</p>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => api.seedExamples().then(refresh)}>Restore examples</button>
            <button className="primary" onClick={create}>New flow</button>
          </div>
        </div>
        {error && <div className="banner error">{error}</div>}
        {!flows ? (
          <p className="muted">Loading…</p>
        ) : !flows.length ? (
          <div className="empty">No flows yet. Create one or restore the examples.</div>
        ) : (
          <table className="flows">
            <thead>
              <tr><th>Name</th><th>Endpoint</th><th>Status</th><th>Version</th><th /></tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.id}>
                  <td><a href={`#/flows/${f.id}`}>{f.name}</a></td>
                  <td><code>{triggerMethod(f)} {f.endpoint}</code></td>
                  <td><StatusBadge status={f.status} title={f.last_error ?? undefined} /></td>
                  <td className="muted">v{f.version}{f.deployed_version ? ` (live v${f.deployed_version})` : ''}</td>
                  <td className="actions">
                    <button disabled={busy === f.id} onClick={() => act(f, 'deploy')}>{busy === f.id ? '…' : 'Deploy'}</button>
                    {f.deployed_version != null && <button className="ghost" disabled={busy === f.id} onClick={() => act(f, 'undeploy')}>Undeploy</button>}
                    <button className="ghost danger" disabled={busy === f.id} onClick={() => act(f, 'delete')}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

function triggerMethod(f: FlowRecord): string {
  const t = f.graph.nodes.find((n) => n.type === 'trigger');
  return t?.type === 'trigger' ? t.data.method : 'GET';
}

export function PlatformPill({ status }: { status: PlatformStatus | null }) {
  if (!status) return <span className="pill">checking gateway…</span>;
  const cpOk = !status.controlPlane.error;
  const dpOk = status.dataPlane.ready;
  const title = [
    cpOk ? `Konnect CP ${status.controlPlane.id}` : `Konnect: ${status.controlPlane.error}`,
    dpOk ? `DP ready (config ${status.dataPlane.configHash?.slice(0, 8)})` : 'DP not ready',
  ].join('\n');
  return (
    <span className="pill" title={title}>
      <i className={cpOk ? 'dot ok' : 'dot bad'} /> Konnect
      <i className={dpOk ? 'dot ok' : 'dot bad'} /> Data plane
    </span>
  );
}

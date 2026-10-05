import { useEffect, useState } from 'react';
import { api, type DbConnection, type PlatformStatus } from '../api';
import { ConnectionForm } from './ConnectionForm';
import { Nav, PlatformPill } from './FlowList';

export function ConnectionsPage() {
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<{ kind: 'new' } | { kind: 'rotate'; conn: DbConnection } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = () => api.connections().then(setConns).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
    api.status().then(setStatus).catch(() => undefined);
  }, []);

  const test = async (c: DbConnection) => {
    setTesting(c.name);
    setError(null);
    try {
      const r = await api.testConnection(c.name);
      setFlash(r.ok ? `${c.name}: connected through the vault in ${r.durationMs} ms` : null);
      if (!r.ok) setError(`${c.name}: ${r.error}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(null);
      refresh();
    }
  };

  const remove = async (c: DbConnection) => {
    if (!confirm(`Delete connection "${c.name}"? Its connection string is removed from the Konnect vault.`)) return;
    try {
      await api.deleteConnection(c.name);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><img src="/favicon.svg" alt="" /> Flow Builder</div>
        <Nav active="connections" />
        <span className="spacer" />
        <PlatformPill status={status} />
      </header>
      <main className="list">
        <div className="list-head">
          <div>
            <h1>Database connections</h1>
            <p className="muted">
              Connection strings are stored in a Konnect Config Store and read by the data plane through the vault at request time.
              Rotating one updates every flow that uses it, with no redeploy (allow about 10 seconds).
            </p>
          </div>
          <button className="primary" onClick={() => setMode({ kind: 'new' })}>New connection</button>
        </div>
        {error && <div className="banner error">{error}</div>}
        {flash && <div className="banner ok" onClick={() => setFlash(null)}>{flash}</div>}
        {mode && (
          <div className="card">
            <h3>{mode.kind === 'new' ? 'New connection' : `Rotate ${mode.conn.name}`}</h3>
            <ConnectionForm
              existing={mode.kind === 'rotate' ? mode.conn : undefined}
              onCancel={() => setMode(null)}
              onSaved={(c) => {
                setMode(null);
                setFlash(`${c.name} saved to the vault`);
                refresh();
              }}
            />
          </div>
        )}
        {!conns ? <p className="muted">Loading…</p> : !conns.length ? (
          <div className="empty">No connections yet.</div>
        ) : (
          <table className="flows">
            <thead>
              <tr><th>Name</th><th>Database</th><th>Vault reference</th><th>Used by</th><th>Last test</th><th /></tr>
            </thead>
            <tbody>
              {conns.map((c) => (
                <tr key={c.name}>
                  <td><b>{c.name}</b>{c.description && <div className="muted small">{c.description}</div>}</td>
                  <td><code>{c.username}@{c.host}:{c.port}/{c.database}</code></td>
                  <td><code>{'{vault://ipaasdb/'}{c.name}{'}'}</code></td>
                  <td className="small">{c.used_by.length ? c.used_by.map((f) => <a key={f.id} href={`#/flows/${f.id}`} className="chip">{f.name}</a>) : <span className="muted">-</span>}</td>
                  <td className="small">
                    {c.test_ok == null ? <span className="muted">never</span> : c.test_ok
                      ? <span className="badge live">ok</span>
                      : <span className="badge error" title={c.test_error ?? ''}>failed</span>}
                  </td>
                  <td className="actions">
                    <button disabled={testing === c.name} onClick={() => test(c)}>{testing === c.name ? '…' : 'Test'}</button>
                    <button className="ghost" onClick={() => setMode({ kind: 'rotate', conn: c })}>Rotate</button>
                    <button className="ghost danger" disabled={c.used_by.length > 0} title={c.used_by.length ? 'In use by flows' : ''} onClick={() => remove(c)}>Delete</button>
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

import { useState } from 'react';
import { api, type DbConnection, type QueryResult } from '../api';

interface Props {
  /** Present when rotating an existing connection. */
  existing?: DbConnection;
  onSaved: (c: DbConnection) => void;
  onCancel?: () => void;
  compact?: boolean;
}

/** Create or rotate a connection. The string goes straight to Vault and is not shown again. */
export function ConnectionForm({ existing, onSaved, onCancel, compact }: Props) {
  const [name, setName] = useState(existing?.name ?? '');
  const [conn, setConn] = useState('');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [skipTest, setSkipTest] = useState(false);

  const test = async () => {
    setBusy('test');
    try {
      const r: QueryResult = await api.testConnectionString(conn);
      setResult(r.ok ? { ok: true, text: `Connected (${r.durationMs} ms)` } : { ok: false, text: r.error });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setResult(null);
    try {
      const c = existing
        ? await api.updateConnection(existing.name, { connectionString: conn || undefined, description, skipTest })
        : await api.createConnection({ name, connectionString: conn, description, skipTest });
      onSaved(c);
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`conn-form ${compact ? 'compact' : ''}`}>
      {!existing && (
        <label className="field"><span>Name</span>
          <input className="mono" value={name} placeholder="crm" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
          <small className="muted">Lowercase letters, digits and _. Flows refer to the connection by this name.</small>
        </label>
      )}
      <label className="field"><span>{existing ? 'New connection string (rotates the stored one)' : 'Connection string'}</span>
        <input
          className="mono" type="password" autoComplete="off" value={conn}
          placeholder="postgres://user:password@host:5432/database"
          onChange={(e) => setConn(e.target.value)}
        />
        <small className="muted">
          Stored only in Vault at <code>ipaas/db/{name || 'name'}</code> and not shown again. Flows refer to it by name only.
          From containers, reach your Mac's databases at <code>host.docker.internal</code>.
        </small>
      </label>
      {!compact && (
        <label className="field"><span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </label>
      )}
      <label className="check"><input type="checkbox" checked={skipTest} onChange={(e) => setSkipTest(e.target.checked)} /> Save without testing</label>
      {result && <div className={`banner ${result.ok ? 'ok' : 'error'} small`}>{result.text}</div>}
      <div className="row">
        <button onClick={test} disabled={!conn || !!busy}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        <span className="spacer" />
        {onCancel && <button className="ghost" onClick={onCancel}>Cancel</button>}
        <button className="primary" onClick={save} disabled={!!busy || (!existing && (!name || !conn)) || (!!existing && !conn && description === existing.description)}>
          {busy === 'save' ? 'Saving…' : existing ? 'Save' : 'Save to Vault'}
        </button>
      </div>
    </div>
  );
}

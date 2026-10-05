import { useEffect, useMemo, useState } from 'react';
import type { DatabaseData } from '@ipaas/flow-core';
import { api, type DbConnection, type QueryResult } from '../api';
import { ConnectionForm } from './ConnectionForm';

interface Props {
  data: DatabaseData;
  inputs: string[];
  onChange: (patch: Partial<DatabaseData>) => void;
}

/** `:name` variables in the SQL, ignoring `::casts`, strings and comments (best effort, for the editor). */
export function sqlVariables(sql: string): string[] {
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/::/g, '  ');
  const out: string[] = [];
  for (const m of stripped.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function DatabaseFields({ data, inputs, onChange }: Props) {
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const params = data.params ?? {};
  const detected = useMemo(() => sqlVariables(data.sql ?? ''), [data.sql]);
  const names = useMemo(() => [...new Set([...detected, ...Object.keys(params)])], [detected, params]);

  useEffect(() => {
    api.connections().then(setConns).catch((e) => setConnErr(e.message));
  }, []);
  const selected = conns?.find((c) => c.name === data.connection);

  const setParam = (name: string, expr: string | null) => {
    const next = { ...params };
    if (expr === null) delete next[name];
    else next[name] = expr;
    onChange({ params: next });
  };

  return (
    <>
      <div className="field">
        <span>Connection (from the Konnect vault)</span>
        <div className="row">
          <select
            className="grow" value={data.connection} disabled={!conns}
            onChange={(e) => (e.target.value === '__new__' ? setCreating(true) : onChange({ connection: e.target.value }))}
          >
            {(!conns || !selected) && <option value={data.connection}>{data.connection ? `${data.connection} (not found)` : '(choose a connection)'}</option>}
            {conns?.map((c) => <option key={c.name} value={c.name}>{c.name}: {c.username}@{c.host}/{c.database}</option>)}
            <option value="__new__">+ New connection…</option>
          </select>
        </div>
        <small className={connErr || (conns && !selected) ? 'warn' : 'muted'}>
          {connErr ? connErr
            : !conns ? 'Loading connections…'
            : !selected ? 'Choose an existing connection or create one.'
            : <>Resolved at request time from <code>{'{vault://ipaasdb/'}{selected.name}{'}'}</code>. <a href="#/connections">Manage connections</a></>}
        </small>
      </div>
      {creating && (
        <div className="card inset">
          <ConnectionForm
            compact
            onCancel={() => setCreating(false)}
            onSaved={(c) => {
              setCreating(false);
              setConns([...(conns ?? []).filter((x) => x.name !== c.name), { ...c, used_by: [] }]);
              onChange({ connection: c.name });
            }}
          />
        </div>
      )}

      <label className="field">
        <span>SQL</span>
        <textarea className="mono" rows={7} spellCheck={false} value={data.sql} onChange={(e) => onChange({ sql: e.target.value })} />
        <small className="muted">Use <code>:name</code> for variables. Values are bound as query parameters and never pasted into the SQL.</small>
      </label>

      <div className="field">
        <span>Variables (jq over inputs)</span>
        {!names.length && <small className="muted">No <code>:variables</code> in the SQL.</small>}
        {names.map((n) => (
          <div key={n} className="var-row">
            <code className={detected.includes(n) ? '' : 'unused'} title={detected.includes(n) ? '' : 'Not used in the SQL'}>:{n}</code>
            <input
              className="mono" value={params[n] ?? ''} placeholder={inputs[0] ? `.${inputs[0]}.query.${n}` : '"literal"'}
              onChange={(e) => setParam(n, e.target.value)}
            />
            {!detected.includes(n) && <button className="ghost danger" onClick={() => setParam(n, null)} title="Remove">×</button>}
          </div>
        ))}
      </div>

      <label className="field">
        <span>Status on query error</span>
        <input type="number" value={data.errorStatus ?? 502} onChange={(e) => onChange({ errorStatus: Number(e.target.value) })} />
        <small className="muted">If the query fails, the flow stops and returns this status with the database error message.</small>
      </label>

      <QueryRunner connection={data.connection} sql={data.sql} names={detected} />
    </>
  );
}

function QueryRunner({ connection, sql, names }: { connection: string; sql: string; names: string[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const params = Object.fromEntries(names.map((n) => [n, parseLiteral(values[n] ?? '')]));
      setResult(await api.dbQuery({ connection, sql, params }));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="runner">
      <span className="runner-title">Try the query</span>
      {names.map((n) => (
        <div key={n} className="var-row">
          <code>:{n}</code>
          <input className="mono" placeholder="test value" value={values[n] ?? ''} onChange={(e) => setValues({ ...values, [n]: e.target.value })} />
        </div>
      ))}
      <button onClick={run} disabled={busy || !sql.trim()}>{busy ? 'Running…' : 'Run query'}</button>
      {result && (result.ok ? (
        <div className="small">
          <p className="muted">{result.rowCount} row(s) · {result.durationMs} ms{result.truncated ? ' · truncated' : ''}</p>
          {result.rows.length > 0 && (
            <div className="result-table">
              <table>
                <thead><tr>{result.fields.map((f) => <th key={f}>{f}</th>)}</tr></thead>
                <tbody>
                  {result.rows.slice(0, 20).map((r, i) => (
                    <tr key={i}>{result.fields.map((f) => <td key={f}>{fmt(r[f])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="banner error small">{result.error}{result.code ? ` (${result.code})` : ''}{result.detail ? `\n${result.detail}` : ''}</div>
      ))}
    </div>
  );
}

/** Test values: numbers, booleans, null and JSON are parsed; anything else is a string. */
function parseLiteral(v: string): unknown {
  const t = v.trim();
  if (t === '') return null;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

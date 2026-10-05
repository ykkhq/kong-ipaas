/**
 * Rewrites `:name` placeholders to positional `$n` parameters, skipping string
 * literals, quoted identifiers, dollar-quoted bodies, comments and `::` casts.
 * Values are always bound as parameters, never interpolated into the SQL.
 */
export function bindNamed(sql: string, params: Record<string, unknown> = {}): { text: string; values: unknown[] } {
  const order: string[] = [];
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'" || c === '"') {
      const end = scanQuoted(sql, i, c);
      out += sql.slice(i, end);
      i = end;
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
      } else {
        out += c;
        i++;
      }
    } else if (c === ':' && next === ':') {
      out += '::';
      i += 2;
    } else if (c === ':' && /[A-Za-z_]/.test(next ?? '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      const name = m[0];
      if (!Object.prototype.hasOwnProperty.call(params, name)) throw new ParamError(`Missing value for query variable :${name}`);
      let idx = order.indexOf(name);
      if (idx === -1) idx = order.push(name) - 1;
      out += `$${idx + 1}`;
      i += 1 + name.length;
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, values: order.map((k) => toPgValue(params[k])) };
}

function scanQuoted(sql: string, start: number, q: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** Objects become JSON text (for json/jsonb columns); arrays stay arrays (PG arrays). */
function toPgValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

export class ParamError extends Error {}

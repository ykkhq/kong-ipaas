import { describe, expect, it } from 'vitest';
import { bindNamed } from '../src/params';

describe('bindNamed', () => {
  it('maps named variables to positional parameters, reusing indexes', () => {
    expect(bindNamed('SELECT * FROM t WHERE a = :a AND b = :b OR a2 = :a', { a: 1, b: 'x' }))
      .toEqual({ text: 'SELECT * FROM t WHERE a = $1 AND b = $2 OR a2 = $1', values: [1, 'x'] });
  });

  it('ignores casts, strings, identifiers, comments and dollar quotes', () => {
    const sql = `SELECT ':nope', ":nope", x::int, $$ :nope $$, $f$ :nope $f$ -- :nope
      /* :nope */ FROM t WHERE id = :id`;
    const r = bindNamed(sql, { id: 7 });
    expect(r.values).toEqual([7]);
    expect(r.text).toContain('id = $1');
    expect(r.text.match(/\$1/g)).toHaveLength(1);
    expect(r.text).toContain("':nope'");
  });

  it('handles escaped quotes', () => {
    expect(bindNamed("SELECT 'it''s :x' , :y", { y: 1 }).text).toBe("SELECT 'it''s :x' , $1");
  });

  it('rejects missing variables', () => {
    expect(() => bindNamed('SELECT :missing', {})).toThrow(/Missing value for query variable :missing/);
  });

  it('JSON-encodes objects and keeps arrays and nulls', () => {
    expect(bindNamed('SELECT :o, :a, :n, :u', { o: { k: 1 }, a: [1, 2], n: null, u: undefined }).values).toEqual(['{"k":1}', [1, 2], null, null]);
  });
});

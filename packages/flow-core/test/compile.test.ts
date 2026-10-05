import { describe, expect, it } from 'vitest';
import { compileFlow, exampleFlows, templateToJq, type Flow, type FlowNode } from '../src/index';

const pos = { x: 0, y: 0 };
const trigger: FlowNode = { id: 't', type: 'trigger', position: pos, data: { label: 'Request', method: 'GET' } };
const response = (expr = '.'): FlowNode => ({ id: 'r', type: 'response', position: pos, data: { label: 'Response', status: 200, expr } });
const http = (id: string, label: string, url: string, extra = {}): FlowNode => ({ id, type: 'http', position: pos, data: { label, method: 'GET', url, ...extra } });
const flow = (nodes: FlowNode[], edges: Flow['graph']['edges']): Flow => ({ name: 'T', slug: 'test', graph: { nodes, edges } });
const byName = (r: ReturnType<typeof compileFlow>, name: string) => r.config!.nodes.find((n) => n.name === name);

describe('compileFlow', () => {
  it('compiles the seeded examples', () => {
    for (const f of exampleFlows()) {
      const r = compileFlow(f);
      expect(r.errors).toEqual([]);
      expect(r.config).toMatchSnapshot(f.slug);
    }
  });

  it('keeps independent jobs free of dependencies (parallel fan-out)', () => {
    const r = compileFlow(flow(
      [trigger, http('a', 'A', 'http://x/a'), http('b', 'B', 'http://x/b'), response()],
      [{ id: '1', source: 'a', target: 'r' }, { id: '2', source: 'b', target: 'r' }],
    ));
    expect(r.ok).toBe(true);
    expect(byName(r, 'A')).toEqual({ name: 'A', type: 'call', method: 'GET', url: 'http://x/a' });
    expect(byName(r, 'B')).toEqual({ name: 'B', type: 'call', method: 'GET', url: 'http://x/b' });
    expect(byName(r, 'RESPONSE__BODY')!.inputs).toEqual({ a: 'A.body', b: 'B.body' });
    expect(byName(r, 'RESPONSE')).toMatchObject({ type: 'exit', status: 200, inputs: { body: 'RESPONSE__BODY' } });
    expect(r.route).toEqual({ path: '/flows/test', method: 'GET' });
  });

  it('chains a job after an untemplated edge', () => {
    const r = compileFlow(flow(
      [trigger, http('a', 'A', 'http://x/a'), http('b', 'B', 'http://x/b'), response()],
      [{ id: '1', source: 'a', target: 'b' }, { id: '2', source: 'b', target: 'r' }],
    ));
    expect(byName(r, 'B')!.inputs).toEqual({ headers: 'B__AFTER' });
    expect(byName(r, 'B__AFTER')).toMatchObject({ type: 'jq', inputs: { a: 'A.body' } });
  });

  it('regroups trigger inputs under their alias', () => {
    const r = compileFlow(flow(
      [trigger, http('a', 'A', 'http://x/users/{{ .req.query.id }}'), response()],
      [{ id: '1', source: 't', target: 'a', data: { alias: 'req' } }, { id: '2', source: 'a', target: 'r' }],
    ));
    const url = byName(r, 'A__URL')!;
    expect(url.inputs).toEqual({ req__query: 'request.query', req__headers: 'request.headers' });
    expect(url.jq).toContain('req: {query: .req__query, headers: .req__headers}');
    expect(byName(r, 'A')).toMatchObject({ url: 'http://x/users/_', inputs: { url: 'A__URL' } });
  });

  it('gates downstream-only nodes with a branch', () => {
    const r = compileFlow(flow(
      [
        trigger,
        http('u', 'User', 'http://x/u'),
        { id: 'c', type: 'condition', position: pos, data: { label: 'Gold', expr: '.user.tier == "gold"' } },
        http('l', 'Loyalty', 'http://x/l'),
        { id: 'x', type: 'transform', position: pos, data: { label: 'Shape', expr: '.loyalty' } },
        response(),
      ],
      [
        { id: '1', source: 'u', target: 'c', data: { alias: 'user' } },
        { id: '2', source: 'c', target: 'l', sourceHandle: 'then' },
        { id: '3', source: 'l', target: 'x' },
        { id: '4', source: 'x', target: 'r' },
        { id: '5', source: 'u', target: 'r' },
      ],
    ));
    expect(r.errors).toEqual([]);
    expect(byName(r, 'GOLD__BRANCH')).toEqual({ name: 'GOLD__BRANCH', type: 'branch', input: 'GOLD', then: ['LOYALTY', 'SHAPE'] });
    expect(r.nodeMap.c).toEqual(['GOLD', 'GOLD__BRANCH']);
  });

  it('maps secrets to vault resources', () => {
    const r = compileFlow(flow(
      [trigger, { id: 'k', type: 'secret', position: pos, data: { label: 'Api Key', env: 'IPAAS_SECRET_API_KEY' } }, http('a', 'A', 'http://x', { headers: '{"x-key": .key}' }), response()],
      [{ id: '1', source: 'k', target: 'a', data: { alias: 'key' } }, { id: '2', source: 'a', target: 'r' }],
    ));
    expect(r.config!.resources).toEqual({ vault: { api_key: '{vault://env/ipaas-secret-api-key}' } });
    expect(byName(r, 'A__HEADERS')!.inputs).toEqual({ key: 'vault.api_key' });
  });

  it('compiles a database node into request, call, gate, error exit and result', () => {
    const db: FlowNode = { id: 'd', type: 'database', position: pos, data: { label: 'Users', connection: 'sample', sql: 'SELECT * FROM users WHERE id = :id', params: { id: '.req.query.id' } } };
    const r = compileFlow(flow(
      [trigger, db, http('w', 'Weather', 'http://x/w', { query: '{city: .users.rows[0].city}' }), response()],
      [
        { id: '1', source: 't', target: 'd', data: { alias: 'req' } },
        { id: '2', source: 'd', target: 'w', data: { alias: 'users' } },
        { id: '3', source: 'd', target: 'r', data: { alias: 'users' } },
        { id: '4', source: 'w', target: 'r' },
      ],
    ), { dbAccessUrl: 'http://db:1/' });
    expect(r.errors).toEqual([]);
    expect(byName(r, 'USERS__PARAMS')!.jq).toContain('({"id": (.req.query.id)})');
    expect(byName(r, 'USERS__REQ')).toEqual({
      name: 'USERS__REQ', type: 'jq', inputs: { p: 'USERS__PARAMS' },
      jq: '{connection: "sample", sql: "SELECT * FROM users WHERE id = :id", params: .p}',
    });
    expect(r.config!.resources).toBeUndefined();
    expect(byName(r, 'USERS__CALL')).toEqual({ name: 'USERS__CALL', type: 'call', method: 'POST', url: 'http://db:1/query', timeout: 15000, inputs: { body: 'USERS__REQ' } });
    expect(byName(r, 'USERS__GATE')).toEqual({
      name: 'USERS__GATE', type: 'branch', input: 'USERS__OK', then: ['USERS'], else: ['USERS__ERR_BODY', 'USERS__ERR'],
    });
    const names = r.config!.nodes.map((n) => n.name);
    expect(names.indexOf('USERS__ERR')).toBeLessThan(names.indexOf('USERS'));
    expect(byName(r, 'USERS__ERR')).toMatchObject({ type: 'exit', status: 502, inputs: { body: 'USERS__ERR_BODY' } });
    expect(byName(r, 'WEATHER__QUERY')!.inputs).toEqual({ users: 'USERS' });
    expect(r.failPaths.d).toEqual(['USERS__ERR_BODY', 'USERS__ERR']);
  });

  it('lets a condition skip only the query of a database node', () => {
    const r = compileFlow(flow(
      [
        trigger,
        { id: 'c', type: 'condition', position: pos, data: { label: 'Has Id', expr: '.req.query.id != null' } },
        { id: 'd', type: 'database', position: pos, data: { label: 'Q', connection: 'sample', sql: 'SELECT 1' } },
        response(),
      ],
      [
        { id: '1', source: 't', target: 'c', data: { alias: 'req' } },
        { id: '2', source: 'c', target: 'd', sourceHandle: 'then' },
        { id: '3', source: 'd', target: 'r' },
      ],
    ));
    expect(r.errors).toEqual([]);
    expect(byName(r, 'HAS_ID__BRANCH')!.then).toEqual(['Q__PARAMS', 'Q__REQ', 'Q__CALL']);
  });

  it('validates database nodes', () => {
    const r = compileFlow(flow(
      [trigger, { id: 'd', type: 'database', position: pos, data: { label: 'Q', connection: '', sql: ' ', params: { 'bad-name': '1', ok: '' } } }, response()],
      [{ id: '1', source: 'd', target: 'r' }],
    ));
    expect(r.errors.map((e) => e.message)).toEqual([
      'Q: choose a connection', 'Q: SQL is empty', 'Q: invalid variable name "bad-name"', 'Q: variable :ok has no value expression',
    ]);
  });

  it('compiles an EDI Send node into a guarded edi-gateway call', () => {
    const edi: FlowNode = { id: 'e', type: 'edi_send', position: pos, data: { label: 'Send PO', partner: 'acme', filename: '"PO-" + .req.query.id + ".edi"', content: '.req.query | tostring', contentType: 'application/edifact', errorStatus: 504 } };
    const r = compileFlow(flow(
      [trigger, edi, response()],
      [{ id: '1', source: 't', target: 'e', data: { alias: 'req' } }, { id: '2', source: 'e', target: 'r', data: { alias: 'sent' } }],
    ), { ediGatewayUrl: 'http://edi:1/' });
    expect(r.errors).toEqual([]);
    expect(byName(r, 'SEND_PO__PARAMS')!.jq).toContain('({filename: ("PO-" + .req.query.id + ".edi"), content: (.req.query | tostring)})');
    expect(byName(r, 'SEND_PO__REQ')!.jq).toBe('{partner: "acme", contentType: "application/edifact", filename: .p.filename, content: .p.content}');
    expect(byName(r, 'SEND_PO__CALL')).toMatchObject({ type: 'call', method: 'POST', url: 'http://edi:1/send', timeout: 90000 });
    expect(byName(r, 'SEND_PO__GATE')).toMatchObject({ then: ['SEND_PO'], else: ['SEND_PO__ERR_BODY', 'SEND_PO__ERR'] });
    expect(byName(r, 'SEND_PO__ERR')).toMatchObject({ type: 'exit', status: 504 });
    expect(byName(r, 'SEND_PO__ERR_BODY')!.jq).toContain('error: "edi send failed"');
    expect(r.failPaths.e).toEqual(['SEND_PO__ERR_BODY', 'SEND_PO__ERR']);
  });

  it('validates EDI Send nodes', () => {
    const r = compileFlow(flow([trigger, { id: 'e', type: 'edi_send', position: pos, data: { label: 'E', partner: '', content: ' ' } }, response()],
      [{ id: '1', source: 'e', target: 'r' }]));
    expect(r.errors.map((e) => e.message)).toEqual(['E: choose an EDI partner', 'E: content expression is empty']);
  });

  it('dedupes node names', () => {
    const r = compileFlow(flow([trigger, http('a', 'Call', 'http://x/1'), http('b', 'Call', 'http://x/2'), response()],
      [{ id: '1', source: 'a', target: 'r' }, { id: '2', source: 'b', target: 'r', data: { alias: 'call2' } }]));
    expect(r.config!.nodes.map((n) => n.name)).toContain('CALL_2');
  });

  it.each([
    ['missing response', flow([trigger], []), /exactly one Response/],
    ['cycle', flow([trigger, http('a', 'A', 'http://x'), http('b', 'B', 'http://x'), response()], [
      { id: '1', source: 'a', target: 'b' }, { id: '2', source: 'b', target: 'a' }, { id: '3', source: 'b', target: 'r' }]), /cycle/],
    ['duplicate alias', flow([trigger, http('a', 'A', 'http://x'), http('b', 'B', 'http://x'), response()], [
      { id: '1', source: 'a', target: 'r', data: { alias: 'x' } }, { id: '2', source: 'b', target: 'r', data: { alias: 'x' } }]), /Duplicate input alias/],
    ['bad url', flow([trigger, http('a', 'A', 'ftp://x'), response()], [{ id: '1', source: 'a', target: 'r' }]), /URL must start/],
    ['condition without handle', flow([trigger, { id: 'c', type: 'condition', position: pos, data: { label: 'C', expr: 'true' } }, response()],
      [{ id: '1', source: 'c', target: 'r' }]), /then" or "else/],
    ['input into trigger', flow([trigger, http('a', 'A', 'http://x'), response()], [{ id: '1', source: 'a', target: 't' }, { id: '2', source: 'a', target: 'r' }]), /does not accept inputs/],
  ])('rejects %s', (_name, f, msg) => {
    const r = compileFlow(f);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(msg);
  });
});

describe('templateToJq', () => {
  it('encodes placeholders and keeps raw ones', () => {
    expect(templateToJq('http://x/{{ .a }}?q={{{ .b }}}')).toBe('"http://x/" + ((.a) | tostring | @uri) + "?q=" + ((.b) | tostring)');
    expect(templateToJq('http://x')).toBe('"http://x"');
  });
});

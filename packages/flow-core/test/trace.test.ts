import { describe, expect, it } from 'vitest';
import { compileFlow, exampleFlows, summarizeTrace } from '../src/index';
import ok from './fixtures/trace-ok.json';
import failed from './fixtures/trace-fail.json';

// Fixtures were captured from Kong Gateway 3.16 running the customer-360 example.
const { nodeMap } = compileFlow(exampleFlows()[0]);

describe('summarizeTrace', () => {
  it('extracts the exit body and per-node states', () => {
    const s = summarizeTrace(ok as any, nodeMap);
    expect(s.status).toBe('PLAN_COMPLETE');
    expect((s.exit!.body as any).customer.name).toBe('Grace Hopper');
    expect(s.byUiNode.user.state).toBe('complete');
    expect(s.byUiNode.loyalty.state).toBe('skip');
    expect((s.byUiNode.user.output as any).body.tier).toBe('silver');
    expect(s.byUiNode.user.endMs!).toBeGreaterThan(s.byUiNode.user.startMs!);
  });

  it('marks the failing node and cancels dependants', () => {
    const s = summarizeTrace(failed as any, nodeMap);
    expect(s.status).toBe('PLAN_ERROR');
    expect(s.byUiNode.user.state).toBe('fail');
    expect(s.byUiNode.response.state).toBe('cancel');
    expect(s.exit).toBeUndefined();
  });
});

describe('summarizeTrace with database nodes', async () => {
  // Captured from Kong 3.16 running the customer-db example against db-access + Postgres 16.
  const dbOk = (await import('./fixtures/trace-db-ok.json')).default;
  const dbFail = (await import('./fixtures/trace-db-fail.json')).default;
  const compiled = compileFlow(exampleFlows().find((f) => f.slug === 'customer-db')!);

  it('reports rows and a completed node on success', () => {
    const s = summarizeTrace(dbOk as any, compiled.nodeMap, compiled.failPaths);
    expect(s.exit!.name).toBe('RESPONSE');
    expect((s.exit!.body as any).customer.name).toBe('Ada Lovelace');
    expect(s.byUiNode.customer.state).toBe('complete');
    expect(s.byUiNode.orders.state).toBe('complete');
  });

  it('marks the database node failed and returns the error exit body', () => {
    const s = summarizeTrace(dbFail as any, compiled.nodeMap, compiled.failPaths);
    expect(s.exit!.name).toBe('FIND_CUSTOMER__ERR');
    expect(s.exit!.body).toMatchObject({ error: 'database query failed', node: 'Find Customer', code: '22P02' });
    expect(s.byUiNode.customer.state).toBe('fail');
    expect((s.byUiNode.customer.error as any).message).toMatch(/invalid input syntax for type integer/);
  });
});

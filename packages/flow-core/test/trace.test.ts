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

import { describe, expect, it } from 'vitest';
import { DbAccessManager, dbAccessEnv } from '../src/dbaccess';
import type { Docker } from '../src/docker';

function fakeDocker(state: { container?: any; imageId?: string }) {
  const calls: string[] = [];
  const docker = {
    inspectImage: async () => (state.imageId ? { Id: state.imageId } : null),
    inspectContainer: async (name: string) => (name === 'ipaas-db-access' ? state.container ?? null : { NetworkSettings: { Networks: { ipaas_default: {} } } }),
    request: async (method: string, path: string, body?: any) => {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (method === 'POST' && path.startsWith('/containers/create')) {
        state.container = { Id: 'c1', Image: body.Image === 'img' ? state.imageId : 'x', State: { Running: false }, body };
        return { Id: 'c1' };
      }
      if (method === 'POST' && path.endsWith('/start')) state.container.State.Running = true;
      if (method === 'DELETE') state.container = undefined;
      return {};
    },
  } as unknown as Docker;
  return { docker, calls, state };
}

const healthy = (async () => new Response(JSON.stringify({ ok: true, connections: ['sample'] }))) as typeof fetch;
const opts = { image: 'img', containerName: 'ipaas-db-access', alias: 'db-access', url: 'http://db-access:4020', env: { MAX_ROWS: '5' } };

describe('DbAccessManager', () => {
  it('creates and starts the container on the API network with the alias and env', async () => {
    const { docker, calls, state } = fakeDocker({ imageId: 'sha256:1' });
    const s = await new DbAccessManager(opts, docker, healthy).ensure();
    expect(s).toMatchObject({ state: 'running', container: 'ipaas-db-access' });
    expect(calls).toEqual(['POST /containers/create', 'POST /containers/c1/start']);
    expect(state.container.body).toMatchObject({
      Env: ['MAX_ROWS=5'],
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'ipaas_default' },
      NetworkingConfig: { EndpointsConfig: { ipaas_default: { Aliases: ['db-access'] } } },
    });
  });

  it('leaves a running, up-to-date container alone', async () => {
    const { docker, calls } = fakeDocker({ imageId: 'sha256:1', container: { Id: 'c1', Image: 'sha256:1', State: { Running: true } } });
    await new DbAccessManager(opts, docker, healthy).ensure();
    expect(calls).toEqual([]);
  });

  it('recreates the container when the image was rebuilt', async () => {
    const { docker, calls } = fakeDocker({ imageId: 'sha256:2', container: { Id: 'old', Image: 'sha256:1', State: { Running: true } } });
    await new DbAccessManager(opts, docker, healthy).ensure();
    expect(calls).toEqual(['DELETE /containers/old', 'POST /containers/create', 'POST /containers/c1/start']);
  });

  it('reports a missing image', async () => {
    const { docker } = fakeDocker({});
    const s = await new DbAccessManager(opts, docker, healthy).ensure();
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/Image img not found/);
  });

  it('passes only tuning variables, never credentials', () => {
    expect(dbAccessEnv({ DB_CONN_SAMPLE: 'postgres://u:p@h/d', KONNECT_PAT: 'secret', MAX_ROWS: '5' })).toEqual({ MAX_ROWS: '5' });
  });
});

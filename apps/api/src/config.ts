import { existsSync, readFileSync } from 'node:fs';

const env = process.env;

/** KONNECT_PAT env var, else the compose secret mounted from KONNECT_PAT_FILE (default ~/.kong/kpat). */
function konnectPat(): string {
  if (env.KONNECT_PAT) return env.KONNECT_PAT.trim();
  const file = env.KONNECT_PAT_SECRET ?? '/run/secrets/konnect_pat';
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://ipaas:ipaas@localhost:5432/ipaas',
  konnect: {
    pat: konnectPat(),
    region: env.KONNECT_REGION ?? 'us',
    cpName: env.KONNECT_CP_NAME ?? 'ipaas-local',
  },
  /** Where the API reaches the data plane (inside the compose network). */
  dpProxyUrl: env.DP_PROXY_URL ?? 'http://kong-dp:8000',
  dpStatusUrl: env.DP_STATUS_URL ?? 'http://kong-dp:8100',
  /** Gateway URL shown to users (from the host). */
  publicGatewayUrl: env.PUBLIC_GATEWAY_URL ?? 'http://localhost:8000',
  /** Base URL of the mock job service as seen from the data plane, used by seed flows. */
  mocksUrl: env.MOCKS_URL ?? 'http://mocks:4010',
  syncTimeoutMs: Number(env.SYNC_TIMEOUT_MS ?? 45000),
  /** edi-gateway internal API as seen from the data plane (EDI Send nodes). */
  ediGatewayUrl: env.EDI_GATEWAY_URL ?? 'http://edi-gateway:4100',
  dbAccess: {
    image: env.DB_ACCESS_IMAGE ?? 'ipaas-db-access:latest',
    containerName: env.DB_ACCESS_CONTAINER ?? 'ipaas-db-access',
    alias: 'db-access',
    url: env.DB_ACCESS_URL ?? 'http://db-access:4020',
    network: env.DB_ACCESS_NETWORK || undefined,
  },
  vault: {
    addr: env.VAULT_ADDR ?? 'http://vault:8200',
    mount: env.VAULT_KV_MOUNT ?? 'ipaas',
    /** Written by the Vault bootstrap into the vault-tokens volume. */
    apiTokenFile: env.VAULT_API_TOKEN_FILE ?? '/vault/tokens/api-token',
    dbAccessTokenFile: env.VAULT_DB_ACCESS_TOKEN_FILE ?? '/vault/tokens/db-access-token',
  },
};

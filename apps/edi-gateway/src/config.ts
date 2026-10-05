const env = process.env;

export const config = {
  /** Admin + internal API (flows call /send; the UI uses /api/edi/* via nginx). */
  port: Number(env.PORT ?? 4100),
  databaseUrl: env.DATABASE_URL ?? 'postgres://ipaas:ipaas@localhost:5432/ipaas',
  dataDir: env.EDI_DATA_DIR ?? '/data',
  vault: {
    addr: env.VAULT_ADDR ?? 'http://vault:8200',
    mount: env.VAULT_KV_MOUNT ?? 'ipaas',
    tokenFile: env.VAULT_TOKEN_FILE ?? '/vault/tokens/edi-token',
  },
  /** Where inbound documents are forwarded (the data plane proxy). */
  gatewayUrl: env.DP_PROXY_URL ?? 'http://kong-dp:8000',
  as2: {
    port: Number(env.AS2_PORT ?? 4080),
    /** URL partners use to reach us (for async MDN and partner setup). */
    publicUrl: env.AS2_PUBLIC_URL ?? 'http://localhost:4080/as2',
    httpTimeoutMs: Number(env.AS2_TIMEOUT_MS ?? 60000),
  },
  sftp: {
    port: Number(env.SFTP_PORT ?? 2222),
    pollIntervalMs: Number(env.SFTP_POLL_MS ?? 30000),
  },
};

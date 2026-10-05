# Flow Builder: a local iPaaS on Kong Konnect and DataKit

Draw a flow of jobs in the browser and deploy it. Requesting the flow's endpoint then runs the whole chain on the Kong data plane and returns the aggregated result.

There is no custom execution engine. Each flow is compiled into a **DataKit** plugin config, pushed to a **Konnect** hybrid control plane, and executed by a **local Kong data plane** container.

```
Browser ─► web :3000 (React Flow) ─/api─► api (Fastify) ─► postgres
                                            └─► Konnect Admin API (service + route + datakit plugin)
                                                        │ config sync
Client ──► kong-dp :8000 /flows/<slug> ◄────────────────┘
              └─ DataKit DAG ─► mocks:4010 / any API
                            └─► db-access:4020 ─► sample-db (Postgres 16) / your databases
                                   └─ reads connection strings from vault:8200 (read-only token)
```

| Container | Role |
|---|---|
| `konnect-init` | One-shot bootstrap. Finds or creates the control plane `KONNECT_CP_NAME`, generates and pins a DP client certificate, and writes cluster endpoints to the `dp-certs` volume. |
| `kong-dp` | Kong Gateway 3.16 data plane connected to Konnect. Serves `http://localhost:8000/flows/<slug>`. |
| `api` | Flow CRUD, flow → DataKit compiler, Konnect deployer, test runner with trace. |
| `web` | Flow designer UI, served by nginx, which also proxies `/api`. |
| `postgres` | Stores flows. |
| `db-access` | SQL executor for Database nodes (`POST /query`). It resolves connection names from Vault with a read-only token. It isn't started by compose: the API starts the `ipaas-db-access` container once a flow contains a Database node and keeps it running. The `db-access-image` compose service only builds its image. |
| `edi-gateway` | EDI protocols: SFTP (client and hosted server on port 2222) and EDIINT AS2 (endpoint on port 4080). It holds partner settings and the message log, and forwards inbound documents to flows. |
| `vault` | Local HashiCorp Vault holding database connection strings. It initializes and unseals itself. |
| `sample-db` | Stub Postgres 16 with `customers`, `orders`, `order_items` and `products` (connection `sample`). |
| `mocks` | Sample job APIs (`/users/:id`, `/users/:id/orders`, `/weather`, `/loyalty/:tier`, `/inventory` (XML), `/echo`). |

## Quick start

Prerequisites: Docker with Compose v2.24+, and a Konnect personal access token (or system account token) that can create control planes, saved in `~/.kong/kpat`.

```sh
cp .env.example .env          # check KONNECT_REGION; the token is read from ~/.kong/kpat
cp secrets.env.example secrets.env   # optional: values for Secret nodes
docker compose up --build -d
open http://localhost:3000
```

Two example flows are seeded:

- **Customer 360**: `GET /flows/customer-360?id=1`. Fetches the user and their orders in parallel. It then fetches weather for the user's city, and loyalty only when the user's tier is gold. It returns one aggregated JSON document.
- **Customer from Database**: `GET /flows/customer-db?id=3`. Two parallel SQL queries (customer, orders with totals) plus a weather lookup for the customer's city. `?id=abc` shows the error path: the flow stops and returns `502` with the Postgres message.
- **Inventory**: `GET /flows/inventory`. Fetches XML, converts it to JSON and filters items in stock.

Open a flow, click **Deploy**, then use the **Test run** tab or curl:

```sh
curl 'http://localhost:8000/flows/customer-360?id=1'
```

## Designing flows

| Node | Compiles to | Notes |
|---|---|---|
| Trigger | Route `/flows/<slug>` + `request` | Downstream jq sees `.alias.query`, `.alias.headers` and, for non-GET, `.alias.body` |
| Database | `jq` request → `call` db-access → `branch` → result or error `exit` | SQL with `:name` variables, each set by a jq expression over the inputs. Downstream jq gets `.alias.rows`, `.alias.row_count` and `.alias.fields`. |
| HTTP Job | `call` (+ jq helpers) | URL template `{{ jq }}` (URI-encoded) or `{{{ jq }}}` (raw). Query, headers and body are jq expressions. |
| Transform | `jq` | Inputs are keyed by edge alias |
| Condition | `jq` + `branch` | `then`/`else` edges gate which nodes run. Skipped jobs pass `null` downstream. |
| Static | `static` | Constant values |
| Secret | `resources.vault` (`{vault://env/…}`) | Value comes from `secrets.env` on the data plane |
| XML → JSON | `xml_to_json` | |
| Response | `jq` + `exit` | Aggregates all inputs. The default `.` returns `{alias: value, …}`. |

- **Edges carry data.** The source's output (`body` for HTTP jobs) is available in the target's jq as `.<alias>`. You can edit the alias by clicking the edge.
- **Parallelism is automatic.** Jobs with no path between them run concurrently. Drawing an edge makes the target wait for the source.
- **A failing job** (non-2xx response) fails the flow, and DataKit cancels its dependants. The Test run tab shows which node failed.

### Database nodes and connections

- **Connections are managed in the UI** (**Connections** page, or **+ New connection…** in the Database node's connection picker).
  - A connection string is tested first, then written to the **local Vault** at `ipaas/db/<name>` (KV v2).
  - Postgres keeps only the non-secret details (host, port, database, user) for listing.
- **Reuse by name.** A Database node picks an existing connection, and the flow's DataKit config contains only the connection name. db-access reads the string from Vault with a **read-only token** and caches it for up to 60 s. Neither Kong nor Konnect ever sees a connection string.
- **Rotation.** Use **Rotate** on the Connections page. The API tells db-access to drop its cached copy, so the next query of every flow uses the new string, with no redeploy. A connection that flows still use can't be deleted.
- **Seeding.** `DB_CONN_<NAME>=postgres://…` env vars are written to Vault on start when the name isn't there yet. `sample` (the stub DB) is seeded this way.
- **Variables.** Write `:id` in the SQL and set `id` to a jq expression such as `.req.query.id`. Values are always bound as query parameters (`$1`, `$2`, …), never interpolated into the SQL.
- **Errors.** Any failure stops the flow and returns the node's error status (default `502`) with the message. Examples: a SQL error, a bad parameter, a missing variable, an unknown connection, wrong credentials, the database being unreachable, or Vault being unavailable. A typical body is `{"error":"database query failed","node":"Find Customer","message":"…","code":"22P02"}`. If db-access itself is unreachable, the call times out after 15 s with a DataKit `node execution error`.
- **Limits.** Statement timeout is 10 s (`STATEMENT_TIMEOUT_MS`), and a query returns at most 1000 rows (`MAX_ROWS`, flagged as `truncated`).
- **Run query** in the inspector and **Test** on the Connections page call db-access directly, which resolves the connection from Vault exactly as flows do.
- **db-access lifecycle.** Opening, saving or deploying a flow with a Database node starts `ipaas-db-access`. It is recreated when its image or settings change, re-ensured when the API starts, and removed when the API stops, so `docker compose down` stays clean. The API mounts `/var/run/docker.sock` for this.

### Local Vault

- **Startup.** `vault` runs HashiCorp Vault with file storage and initializes and unseals itself on every start (`infra/vault/entrypoint.sh`).
  - First start: one unseal key, the KV v2 engine at `ipaas/`, and the policies `ipaas-api` (read/write `db/*`) and `ipaas-db-access` (read `db/*`).
  - It also creates periodic service tokens, which the services renew.
- **Volumes.**
  - `vault-keys` holds the unseal key and root token. Only the vault container mounts it.
  - `vault-tokens` holds the two service tokens. The API mounts it read-only and passes the read-only token to db-access.
- **Security note.** Anyone with access to the `vault-keys` volume can read every secret. That's fine for local use, but it is not a production setup.
- **Inspecting secrets.** The Vault UI is at http://localhost:8200. For a root login, get the token with `docker compose exec vault cat /vault/keys/root-token`.
- **Upgrading from `v0.2.0`**, which used the Konnect Config Store: on start the API removes the old Konnect vault, config store and system route, then redeploys live database flows. Re-create any connections other than the seeded ones in the UI, because Konnect secrets can't be read back.

### EDI (B2B protocols)

The **EDI** page manages trading partners. Each partner has a protocol, protocol settings, secrets (stored in Vault at `ipaas/edi/partners/<id>`) and an optional **inbound flow**.

- **Sending.** The **EDI Send** node takes a partner, a file name (jq), content (jq; strings are sent as-is, anything else as JSON) and a content type.
  - It returns `.alias.message_id`, `.alias.status` (`delivered`, `sent` or `awaiting-receipt`) and `.alias.receipt`.
  - Any delivery failure stops the flow with the node's error status (default 502) and the protocol error. Examples: connection or authentication errors, a negative MDN, a MIC mismatch, a disabled partner.
- **Receiving.** Every inbound document is logged and stored. If the partner has an inbound flow, edi-gateway POSTs `{edi: {protocol, partner, messageId, id, filename, contentType, size, receivedAt}, encoding: "utf8"|"base64", document}` to `/flows/<slug>`, and the flow's response status is recorded. **Retry** on the Messages tab re-posts a document.
- **Message log.** The **Messages** tab shows direction, status, receipts (MDN disposition, MIC check, signature check, SFTP path), the flow result and the payload.

| Protocol | Send | Receive | Notes |
|---|---|---|---|
| **SFTP**, remote | Upload to `uploadDir`, written as `.part` and then renamed | Polls `pollDir` every 30 s (or **Poll now**), then deletes or moves files to `archiveDir` | Password or private key; pin the host key with `hostKeySha256` (**Test** shows it) |
| **SFTP**, hosted | Drops the file in the partner's `/outbox` on our server | The partner uploads to `/inbox` on `sftp://<host>:2222` | Partner login by public key or password; each partner is chrooted to `/inbox` and `/outbox` |
| **EDIINT AS2** (RFC 4130) | Optional zlib compression (RFC 5402), signature (SHA-1/256/384/512), encryption (AES-128/192/256-CBC, 3DES) and HTTP basic auth; sync, async or no MDN | `POST http://<host>:4080/as2`; decrypts, decompresses and verifies, enforces the require-signed/require-encrypted policy, and returns a sync or async MDN, signed if requested, with RFC 4130 error dispositions | Station AS2 ID and certificate on **Our station**; the private key lives in Vault. Crypto uses the OpenSSL `cms` CLI |

`demo-sftp` (hosted, login `demo`, no credentials until you add a key or password) and the **EDI Inbox** and **Orders to EDI** flows are seeded as examples.
Interop tests against pyas2lib (AS2) and OpenSSH (SFTP) are described in [`tests/interop/README.md`](tests/interop/README.md).

Each deployed flow becomes three Konnect entities tagged `ipaas` and `flow-<id>`: a Service `ipaas-<slug>`, a Route and a `datakit` plugin. Their ids are deterministic (UUIDv5 of the flow id), so redeploys upsert in place.

## Configuration

`.env`:

| Variable | Default | |
|---|---|---|
| `KONNECT_PAT_FILE` | `~/.kong/kpat` | File holding the Konnect token, mounted as a compose secret (`KONNECT_PAT` env still overrides it) |
| `KONNECT_REGION` | `us` | `us`, `eu`, `au`, `me`, `in`, `sg` |
| `KONNECT_CP_NAME` | `ipaas-local` | Control plane to use or create |
| `PUBLIC_GATEWAY_URL` | `http://localhost:8000` | Endpoint URL shown in the UI |
| `GATEWAY_PORT`, `WEB_PORT`, `MOCKS_PORT`, … | `8000`, `3000`, `4010` | Host ports |
| `KONG_VERSION` | `3.16` | Data plane image tag |
| `MOCK_DELAY_MS` | `300` | Latency added by the mocks so parallelism is visible |
| `DB_CONN_<NAME>` | `DB_CONN_SAMPLE` → stub DB | Connections seeded into Vault when missing (then managed in the UI) |
| `AS2_PORT`, `SFTP_PORT` | `4080`, `2222` | Host ports of the AS2 endpoint and the hosted SFTP server |
| `AS2_PUBLIC_URL` | `http://localhost:4080/as2` | Our AS2 URL as partners see it (used for async MDNs; can also be set on **Our station**) |
| `VAULT_PORT`, `VAULT_VERSION` | `8200`, `1.20` | Vault UI/API host port and image tag |
| `VAULT_CACHE_TTL_MS` | `60000` | How long db-access caches a connection string (rotation invalidates it immediately) |
| `SAMPLE_DB_PORT` | `5433` | Host port of the stub Postgres |

## Development

```sh
npm install
npm test                         # compiler, trace parser, deployer tests
npm run typecheck
# DataKit check without Konnect: compile the examples into a DB-less kong.yaml
cd packages/flow-core && MOCKS=http://host.docker.internal:4010 npx tsx scripts/to-kong-yaml.ts > /tmp/kong.yaml
```

Layout: `packages/flow-core` (schema, compiler, trace parser, shared with the UI), `apps/api`, `apps/web`, `apps/db-access`, `apps/edi-gateway`, `apps/mocks`, `infra/konnect-init`, `infra/kong-dp`, `infra/sample-db`.

## Troubleshooting

- **`konnect-init` exits with 401.** The token in `~/.kong/kpat` is invalid or expired, or `KONNECT_REGION` is wrong.
- **The Deploy banner says "data plane has not confirmed".** Konnect accepted the config, but `kong-dp` hasn't synced yet. Check `docker compose logs kong-dp` and the data plane nodes page in Konnect.
- **The Database node says "db-access: Image … not found".** Run `docker compose build db-access-image`, or `docker compose up --build`.
- **Database nodes fail with "Vault unavailable".** Check `docker compose logs vault`. Vault unseals itself on start, and if `vault-keys` was deleted while `vault-file` was kept, remove both volumes.
- **A recreated container is unreachable from flows for a while.** Kong caches DNS. The data plane is configured with a 5 s TTL (`KONG_DNS_VALID_TTL`), so wait a few seconds.
- **AS2 partners can't reach us.** Set `AS2_PUBLIC_URL` (or the public URL on **Our station**) to an address the partner can reach, and open port 4080, ideally behind TLS.
- **Reset everything:** `docker compose down -v`. This drops flows, Vault secrets and the DP certificate. The pinned certificate stays in Konnect until you remove it.

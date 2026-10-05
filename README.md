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
```

| Container | Role |
|---|---|
| `konnect-init` | One-shot bootstrap. Finds or creates the control plane `KONNECT_CP_NAME`, generates and pins a DP client certificate, and writes cluster endpoints to the `dp-certs` volume. |
| `kong-dp` | Kong Gateway 3.16 data plane connected to Konnect. Serves `http://localhost:8000/flows/<slug>`. |
| `api` | Flow CRUD, flow → DataKit compiler, Konnect deployer, test runner with trace. |
| `web` | Flow designer UI, served by nginx, which also proxies `/api`. |
| `postgres` | Stores flows. |
| `db-access` | SQL executor for Database nodes (`POST /query`). It holds no credentials: the data plane passes the connection string, resolved from the Konnect vault. It isn't started by compose: the API starts the `ipaas-db-access` container once a flow contains a Database node and keeps it running. The `db-access-image` compose service only builds its image. |
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
  - A connection string is tested first, then written to a **Konnect Config Store** (`ipaas-db-connections`). That store is exposed to the data plane as the vault prefix `ipaasdb`.
  - Konnect never returns secret values. Locally the app keeps only the non-secret details (host, port, database, user) for display.
- **Reuse by name.** A Database node picks an existing connection. The flow's DataKit config contains only `{vault://ipaasdb/<name>}`, which the data plane resolves on each request and passes to db-access. db-access holds no credentials.
- **Rotation.** Use **Rotate** on the Connections page. Every flow using that connection picks up the new string within about 10 to 15 s, with no redeploy. A connection that flows still use can't be deleted.
- **Seeding.** `DB_CONN_<NAME>=postgres://…` env vars are written to the vault once on first start, and existing names are never overwritten. `sample` (the stub DB) is seeded this way.
- **Variables.** Write `:id` in the SQL and set `id` to a jq expression such as `.req.query.id`. Values are always bound as query parameters (`$1`, `$2`, …), never interpolated into the SQL. User jq never sees the connection string.
- **Errors.** Any failure stops the flow and returns the node's error status (default `502`) with the database message. Examples: a SQL error, a bad parameter, a missing variable, a missing vault entry, wrong credentials, or the database being unreachable. A typical body is `{"error":"database query failed","node":"Find Customer","message":"…","code":"22P02"}`. If db-access itself is unreachable, the call times out after 15 s with a DataKit `node execution error`.
- **Limits.** Statement timeout is 10 s (`STATEMENT_TIMEOUT_MS`), and a query returns at most 1000 rows (`MAX_ROWS`, flagged as `truncated`).
- **Run query** in the inspector and **Test** on the Connections page go through an internal gateway route, `POST /_ipaas/db-query`. That route resolves the vault the same way flows do and requires a random token, which is also stored in the vault; without it the route returns `403`.
- **Lifecycle.** Opening, saving or deploying a flow with a Database node starts `ipaas-db-access`. It is recreated when its image is rebuilt, re-ensured when the API starts, and removed when the API stops, so `docker compose down` stays clean. The API mounts `/var/run/docker.sock` for this.

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
| `DB_CONN_<NAME>` | `DB_CONN_SAMPLE` → stub DB | Connections seeded into the Konnect vault on first start (then managed in the UI) |
| `DB_CONFIG_STORE`, `DB_VAULT_PREFIX` | `ipaas-db-connections`, `ipaasdb` | Konnect Config Store and vault prefix for connection strings |
| `SAMPLE_DB_PORT` | `5433` | Host port of the stub Postgres |

## Development

```sh
npm install
npm test                         # compiler, trace parser, deployer tests
npm run typecheck
# DataKit check without Konnect: compile the examples into a DB-less kong.yaml
cd packages/flow-core && MOCKS=http://host.docker.internal:4010 npx tsx scripts/to-kong-yaml.ts > /tmp/kong.yaml
```

Layout: `packages/flow-core` (schema, compiler, trace parser, shared with the UI), `apps/api`, `apps/web`, `apps/db-access`, `apps/mocks`, `infra/konnect-init`, `infra/kong-dp`, `infra/sample-db`.

## Troubleshooting

- **`konnect-init` exits with 401.** The token in `~/.kong/kpat` is invalid or expired, or `KONNECT_REGION` is wrong.
- **The Deploy banner says "data plane has not confirmed".** Konnect accepted the config, but `kong-dp` hasn't synced yet. Check `docker compose logs kong-dp` and the data plane nodes page in Konnect.
- **The Database node says "db-access: Image … not found".** Run `docker compose build db-access-image`, or `docker compose up --build`.
- **Reset everything:** `docker compose down -v`. This drops flows and the DP certificate. The pinned certificate stays in Konnect until you remove it.

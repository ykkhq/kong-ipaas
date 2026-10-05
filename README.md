# Flow Builder: a local iPaaS on Kong Konnect and DataKit

Draw a flow of jobs in the browser and deploy it. Requesting the flow's endpoint then runs the whole chain on the Kong data plane and returns the aggregated result.

There is no custom execution engine. Each flow is compiled into a **DataKit** plugin config, pushed to a **Konnect** hybrid control plane, and executed by a **local Kong data plane** container.

```
Browser ─► web :3000 (React Flow) ─/api─► api (Fastify) ─► postgres
                                            └─► Konnect Admin API (service + route + datakit plugin)
                                                        │ config sync
Client ──► kong-dp :8000 /flows/<slug> ◄────────────────┘
              └─ DataKit DAG ─► mocks:4010 / any API
```

| Container | Role |
|---|---|
| `konnect-init` | One-shot bootstrap. Finds or creates the control plane `KONNECT_CP_NAME`, generates and pins a DP client certificate, and writes cluster endpoints to the `dp-certs` volume. |
| `kong-dp` | Kong Gateway 3.16 data plane connected to Konnect. Serves `http://localhost:8000/flows/<slug>`. |
| `api` | Flow CRUD, flow → DataKit compiler, Konnect deployer, test runner with trace. |
| `web` | Flow designer UI, served by nginx, which also proxies `/api`. |
| `postgres` | Stores flows. |
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
- **Inventory**: `GET /flows/inventory`. Fetches XML, converts it to JSON and filters items in stock.

Open a flow, click **Deploy**, then use the **Test run** tab or curl:

```sh
curl 'http://localhost:8000/flows/customer-360?id=1'
```

## Designing flows

| Node | Compiles to | Notes |
|---|---|---|
| Trigger | Route `/flows/<slug>` + `request` | Downstream jq sees `.alias.query`, `.alias.headers` and, for non-GET, `.alias.body` |
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

## Development

```sh
npm install
npm test                         # compiler, trace parser, deployer tests
npm run typecheck
# DataKit check without Konnect: compile the examples into a DB-less kong.yaml
cd packages/flow-core && MOCKS=http://host.docker.internal:4010 npx tsx scripts/to-kong-yaml.ts > /tmp/kong.yaml
```

Layout: `packages/flow-core` (schema, compiler, trace parser, shared with the UI), `apps/api`, `apps/web`, `apps/mocks`, `infra/konnect-init`, `infra/kong-dp`.

## Troubleshooting

- **`konnect-init` exits with 401.** The token in `~/.kong/kpat` is invalid or expired, or `KONNECT_REGION` is wrong.
- **The Deploy banner says "data plane has not confirmed".** Konnect accepted the config, but `kong-dp` hasn't synced yet. Check `docker compose logs kong-dp` and the data plane nodes page in Konnect.
- **Reset everything:** `docker compose down -v`. This drops flows and the DP certificate. The pinned certificate stays in Konnect until you remove it.

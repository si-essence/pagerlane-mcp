# pagerlane-mcp (Pagerlane MCP connector)

Works with Keep (keephq). Not affiliated with or endorsed by Keep Alerting LTD.

Pagerlane calls a [Keep](https://github.com/keephq/keep) API you already run. It uses stdio or stateless Streamable HTTP. It does not start Keep.

Tool names use the `keep_` prefix because each tool wraps a Keep API route.

The server reads Keep's public REST API only. It contains no Keep source code.

TypeScript 6 is intentional. `typescript-eslint` strict type-aware rules need the JavaScript compiler API, which TypeScript 7 does not ship.

## Setup

```bash
npm install
npm run ci          # typecheck, lint, test, build
npm start           # stdio
npm run start:http  # Streamable HTTP at http://localhost:3000/mcp and /health
```

Copy `.env.example` to `.env` and export the variables in your shell, or set them in the client config. `KEEP_API_URL` is required. Point it at your Keep API, for example `http://localhost:8080` or `https://api.keephq.dev`.

Claude Desktop / any stdio client:

```json
{
  "mcpServers": {
    "pagerlane": {
      "command": "node",
      "args": ["/workspace/connectors/pagerlane/dist/index.js"],
      "env": {
        "KEEP_API_URL": "http://localhost:8080",
        "KEEP_API_KEY": "...",
        "KEEP_CONTACT": "you@example.com"
      }
    }
  }
}
```

Docker (HTTP, no authentication, keep it on localhost):

```bash
docker build -t pagerlane-mcp .
docker run -p 3000:3000 \
  -e KEEP_API_URL=http://host.docker.internal:8080 \
  -e KEEP_API_KEY=your-keep-api-key \
  pagerlane-mcp
```

Register every tool with `registerConnectorTool`. The helper requires a Zod object schema and a non-empty description (`toolDescription`). Calling `server.registerTool` anywhere else fails lint.

## Environment

| Variable             | Default               | Role                                                                                          |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `KEEP_API_URL`       | none, required        | Keep API origin and optional path. No userinfo, query, or hash                                |
| `KEEP_API_KEY`       | unset                 | Required for an upstream call. Sent only as `X-API-KEY`. At least 8 characters. Never printed |
| `KEEP_CONTACT`       | `contact@example.com` | Contact inside the User-Agent. Must not contain the API key                                   |
| `KEEP_PER_MINUTE`    | `30`                  | Local sliding-window cap                                                                      |
| `KEEP_CACHE_TTL_SEC` | `60`                  | TTL for successful reads. `0` disables the cache. Writes are never cached and clear the cache |
| `KEEP_TIMEOUT_MS`    | `20000`               | Upstream timeout                                                                              |
| `MCP_TRANSPORT`      | `stdio`               | `stdio` or `http`. `--http` forces HTTP                                                       |
| `PORT`               | `3000`                | HTTP listen port                                                                              |

Invalid values are reported by field name and issue code. The rejected value is not included in the error.

Auth matches Keep's `APIKeyHeader(name="X-API-KEY")` in `keep/identitymanager/authverifierbase.py:21` (commit `465e991`). The key is never placed in the URL, logs, or tool output.

## Tools

Routes are taken from Keep commit `465e991` (`keep/api/routes/*.py` with prefixes in `keep/api/api.py`). `docs/openapi.json` is v0.24.5 and may be stale. When it disagrees with the routes, the routes win.

| Tool                     | Method and path                                                                                                     | Source                                                                                                                                                                                                           | Notes                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keep_list_alerts`       | `GET /alerts?limit=`                                                                                                | `keep/api/api.py:295`, `keep/api/routes/alerts.py:253`                                                                                                                                                           | Keep default `limit=1000`                                                                                                                                                                                                                                                                                                    |
| `keep_search_alerts`     | `POST /alerts/query`                                                                                                | `alerts.py:195`, body `QueryDto` in `keep/api/models/query.py:10`                                                                                                                                                | CEL search (`cel`, `limit`, `offset`, `sort_by`, `sort_dir`). `POST /alerts/search` (`alerts.py:1293`) is the older SearchEngine path and is not used                                                                                                                                                                        |
| `keep_get_alert`         | `GET /alerts/{fingerprint}`                                                                                         | `alerts.py:784`                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                              |
| `keep_list_incidents`    | `GET /incidents`                                                                                                    | `api.py:296`, `incidents.py:125`                                                                                                                                                                                 | `limit` (default 25), `offset`, `sorting` (`IncidentSorting` in `incident.py:284`), `cel`, `candidate`, `predicted`, plus declared `status`, `severity`, `assignees`, `sources`, `affected_services` query params                                                                                                            |
| `keep_get_incident`      | `GET /incidents/{incident_id}`                                                                                      | `incidents.py:349`                                                                                                                                                                                               | Optional `include_alerts` also calls `GET /incidents/{incident_id}/alerts` (`incidents.py:542`)                                                                                                                                                                                                                              |
| `keep_list_providers`    | `GET /providers`                                                                                                    | `api.py:291`, `providers.py:68`                                                                                                                                                                                  | Strips `details`, `config`, `authentication`, and other credential keys. Installed providers can hold secrets (`ProvidersFactory.get_installed_providers`, `include_details=True` by default). This result is not cached                                                                                                     |
| `keep_list_workflows`    | `GET /workflows`                                                                                                    | `api.py:298`, `workflows.py:178`                                                                                                                                                                                 | A comment at `workflows.py:182` says this GET should be deprecated and removed in favor of `POST /workflows/query` (`workflows.py:195`). This tool still uses GET                                                                                                                                                            |
| `keep_get_topology`      | `GET /topology`                                                                                                     | `api.py:324`, `topology.py:44`                                                                                                                                                                                   | Optional `provider_ids`, `services`, `environment`, `include_empty_deps`                                                                                                                                                                                                                                                     |
| `keep_list_applications` | `GET /topology/applications`                                                                                        | `topology.py:65`                                                                                                                                                                                                 | Services come from topology, not a separate services list                                                                                                                                                                                                                                                                    |
| `keep_acknowledge_alert` | `POST /alerts/enrich?dispose_on_new_alert=true`                                                                     | `alerts.py:1043`, query flag `alerts.py:1052`, body `EnrichAlertRequestBody` in `alert.py:372`                                                                                                                   | Enrichments `{ status: "acknowledged", dismissed: "false", dismissUntil: "" }`. Same path Keep UI uses in `keep-ui/features/alerts/alert-change-status/ui/alert-change-status-modal.tsx`                                                                                                                                     |
| `keep_resolve_alert`     | `POST /alerts/enrich?dispose_on_new_alert=true`                                                                     | same as acknowledge                                                                                                                                                                                              | Enrichments `{ status: "resolved", dismissed: "false", dismissUntil: "" }`                                                                                                                                                                                                                                                   |
| `keep_enrich_alert`      | `POST /alerts/enrich`                                                                                               | `alerts.py:1043`, `alert.py:372`                                                                                                                                                                                 | `fingerprint` plus string `enrichments` map. `dispose_on_new_alert` defaults to false, matching the API                                                                                                                                                                                                                      |
| `keep_update_incident`   | `POST /incidents/{incident_id}/status`, `POST /incidents/{incident_id}/severity`, or `PUT /incidents/{incident_id}` | `incidents.py:839` (`IncidentStatusChangeDto` in `incident.py:22`), `incidents.py:863` (`IncidentSeverityChangeDto` in `incident.py:37`), `incidents.py:380` (`IncidentDtoIn` in `incident.py:42`), `db.py:4129` | One `change` object. Status and severity use their POST routes and send `comment` (status also sends `tagged_users`). `fields` reads the incident, then PUTs the four mutable fields so an omitted `user_summary` or `same_incident_in_the_past_id` is not cleared (`db.py:4165`, `db.py:4173`). Severity is not sent on PUT |
| `keep_run_workflow`      | `POST /workflows/{workflow_id}/run`                                                                                 | `workflows.py:357`, `get_event_from_body` at `workflows.py:315`                                                                                                                                                  | JSON `{ type, body, inputs }`. Omitted `type` means `alert`. Alert `status` and `severity` are optional. Keep defaults them to `firing` and `info` (`alert.py:249`). Replay query params `event_type` and `event_id` load a stored alert. Incident replay is not implemented (`workflows.py:407`)                            |

Read tools use `readOnlyHint: true`. Write tools use `readOnlyHint: false`. Acknowledge, resolve, enrich, and incident update set `idempotentHint: true`. Workflow run sets `idempotentHint: false` because each call creates a new execution.

`update_incident_from_dto_by_id` (`keep/api/core/db.py:4129`) assigns `user_summary` on every user PUT (`db.py:4173`). It also assigns `same_incident_in_the_past_id` when that key is in the DTO dict (`db.py:4165`). `IncidentDtoIn.dict()` always contains the key, so a partial PUT clears both fields. Other DTO fields stay as they are when the new value is null. `IncidentSeverity` values are tuples such as `("critical", 5)` (`keep/api/models/db/incident.py:37`). Severity changes use `POST /incidents/{incident_id}/severity` with `{ severity, comment }`.

`keep_update_incident` takes `incident_id`, `confirm`, and one `change`. `change.kind` is `status`, `severity`, or `fields`. A `fields` change sets at least one of `user_generated_name`, `assignee`, `user_summary`, or `same_incident_in_the_past_id`. That last field is a UUID, or `null` to clear the link. With `confirm: true`, the tool GETs `/incidents/{incident_id}`, parses those four fields, and PUTs them with your values over the stored ones. The PUT body leaves `severity` out. A dry-run makes no upstream call. The preview body lists only the fields you set. Its summary says unspecified `user_summary` and `same_incident_in_the_past_id` will be preserved by reading the current incident first.

`GET /workflows` (`workflows.py:178`) is the list this connector calls. The handler has a comment that it should be deprecated and removed (`workflows.py:182`) in favor of `POST /workflows/query` (`workflows.py:195`). The tool still calls GET.

`POST /workflows/{workflow_id}/run` (`workflows.py:357`) accepts an optional JSON object plus the query params `event_type` and `event_id`. `get_event_from_body` (`workflows.py:315`) reads `type`, `body`, and `inputs`. Omitted `type` means `alert`. Omitted `body` means the outer object is the event. `AlertDto` (`alert.py:75`) declares `status` (`alert.py:78`) and `severity` (`alert.py:79`). Its root validator (`alert.py:249`) sets a missing or invalid status to `firing` and a missing or invalid severity to `info`. The same function fills a missing `name` with `manual-run`, a missing `lastReceived` with the current time, and `id` from `fingerprint` when `id` is missing. The tool types `status` and `severity` when you send them. An alert run rejects the incident-only statuses `merged` and `deleted`. An incident run rejects the alert-only statuses `suppressed`, `pending`, and `maintenance`. Omit `type` to run an alert. For an incident event, `IncidentDto` sets an invalid status to `firing` (`incident.py:159`). When both replay query params are set, Keep loads the stored alert. Incident replay raises `NotImplementedError` in this commit (`workflows.py:407`).

## Confirm and dry-run

Every write tool's input includes `confirm: z.literal(true).optional()`. The only accepted value is the boolean `true`. `confirm: false` and `confirm: "true"` fail Zod and make no upstream call.

When `confirm` is omitted, the tool does not call Keep. It returns a preview:

```json
{
  "dryRun": true,
  "method": "POST",
  "path": "alerts/enrich",
  "query": { "dispose_on_new_alert": true },
  "body": { "fingerprint": "fp-1", "enrichments": { "status": "acknowledged" } },
  "summary": "Acknowledge alert fp-1 via POST /alerts/enrich with status=acknowledged."
}
```

One shared `WritePlan` is built by a pure function, then either previewed or executed. A direct write is `{ kind: "request", method, path, query, body, summary }`. An incident field update is `{ kind: "read-merge-put", path, previewBody, summary }` plus a pure `merge` used only after `confirm` is true. That plan GETs the incident, merges, and PUTs. The dry-run does not call Keep.

## Limits

- In-memory TTL cache (`KEEP_CACHE_TTL_SEC`, default 60 seconds) for reads. A cache hit does not spend the local rate limit. The cache is dropped when the process exits. Writes skip the cache and clear it after a successful call so later reads refetch.
- Local sliding window (`KEEP_PER_MINUTE`, default 30 requests per 60 seconds) around upstream calls.
- When the local window is full, the tool returns `isError` with a `[rate-limit]` message and a retry hint. Cached results are still served.
- Upstream limits still apply. HTTP 429 is returned as `[rate-limit]`. HTTP 404 is `[not-found]`. Other upstream failures are `[upstream]`.
- Response bodies larger than 1,000,000 characters are rejected.
- The API key is redacted from tool results, error text, and logs, including its URL-encoded form. It is refused in the query string, the base URL, and the User-Agent.
- HTTP mode has no authentication. Do not expose it beyond localhost.

## Enterprise and Cloud-only endpoints

This connector does not wrap Keep Enterprise or AI endpoints.

- Identity managers under `ee/identitymanager/` (Auth0, Azure AD, Keycloak) are Keep Enterprise. OSS Keep still authenticates API keys through `keep/identitymanager/authverifierbase.py`.
- `GET /ai/stats` and `PUT /ai/{algorithm_id}/settings` live in MIT `keep/api/routes/ai.py` and are not exposed here.
- Incident PUT accepts `generatedByAi` (`incidents.py:387`). This connector does not send that query flag.
- Incident DTOs include AI-ish fields such as `ai_generated_name` and `is_predicted`. Those can appear in GET responses. This connector does not call incident-AI helpers.

## License and attribution

- Keep's repository is MIT except `ee/`, which is under the Keep Enterprise License. This connector uses only the public REST API and contains no Keep code.
- "Keep" is a trademark of Keep Alerting LTD. This project is not affiliated with, endorsed by, or sponsored by Keep Alerting LTD. No Keep logo is included.
- User-Agent is `pagerlane-mcp/0.1.0 (<KEEP_CONTACT>)`. Point `KEEP_CONTACT` at a real address before production use.
- You are responsible for complying with the Keep instance's own access policy and with any provider credentials stored in that instance.

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Pagerlane project or its owners.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_TITLE, CONNECTOR_VERSION } from "./constants.js";
import {
  acknowledgeAlert,
  acknowledgeAlertInput,
  enrichAlert,
  enrichAlertInput,
  getAlert,
  getAlertInput,
  listAlerts,
  listAlertsInput,
  resolveAlert,
  resolveAlertInput,
  searchAlerts,
  searchAlertsInput,
} from "./keep-alerts.js";
import {
  getIncident,
  getIncidentInput,
  listIncidents,
  listIncidentsInput,
  updateIncident,
  updateIncidentInput,
} from "./keep-incidents.js";
import {
  getTopology,
  getTopologyInput,
  listApplications,
  listApplicationsInput,
  listProviders,
  listProvidersInput,
  listWorkflows,
  listWorkflowsInput,
  runWorkflow,
  runWorkflowInput,
} from "./keep-catalog.js";
import type { Runtime } from "./runtime.js";
import {
  READ_ONLY_REMOTE,
  WRITE_IDEMPOTENT,
  WRITE_NON_IDEMPOTENT,
  registerConnectorTool,
} from "./tools.js";

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({
    name: CONNECTOR_NAME,
    title: CONNECTOR_TITLE,
    version: CONNECTOR_VERSION,
  });
  const ctx = { secrets: runtime.secrets, logger: runtime.logger };

  registerConnectorTool(
    server,
    {
      name: toolName("keep_list_alerts"),
      description: toolDescription(
        "List the latest Keep alerts. GET /alerts with limit (Keep default 1000). Cached reads. Auth is the X-API-KEY header.",
      ),
      inputSchema: listAlertsInput,
      annotations: READ_ONLY_REMOTE,
      handler: async (args) => listAlerts(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_search_alerts"),
      description: toolDescription(
        "Search alerts with CEL. POST /alerts/query with QueryDto (cel, limit, offset, sort_by, sort_dir). This is Keep's current query path. POST /alerts/search is the older SearchEngine route and is not used.",
      ),
      inputSchema: searchAlertsInput,
      annotations: READ_ONLY_REMOTE,
      handler: async (args) => searchAlerts(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_get_alert"),
      description: toolDescription("Get one alert by fingerprint. GET /alerts/{fingerprint}."),
      inputSchema: getAlertInput,
      annotations: READ_ONLY_REMOTE,
      handler: async (args) => getAlert(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_list_incidents"),
      description: toolDescription(
        "List incidents. GET /incidents with limit, offset, sorting, cel, candidate, predicted, and the declared status, severity, assignees, sources, affected_services query params.",
      ),
      inputSchema: listIncidentsInput,
      annotations: READ_ONLY_REMOTE,
      handler: async (args) => listIncidents(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_get_incident"),
      description: toolDescription(
        "Get one incident by UUID. GET /incidents/{incident_id}. Optional include_alerts also calls GET /incidents/{incident_id}/alerts.",
      ),
      inputSchema: getIncidentInput,
      annotations: READ_ONLY_REMOTE,
      handler: async (args) => getIncident(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_list_providers"),
      description: toolDescription(
        "List available, installed, and linked providers. GET /providers. Provider config, details, and credential fields are stripped. This response is not cached.",
      ),
      inputSchema: listProvidersInput,
      annotations: READ_ONLY_REMOTE,
      handler: async () => listProviders(runtime),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_list_workflows"),
      description: toolDescription(
        "List workflows. GET /workflows. Keep's source says this GET should be deprecated and removed in favor of POST /workflows/query. This tool still uses GET.",
      ),
      inputSchema: listWorkflowsInput,
      annotations: READ_ONLY_REMOTE,
      handler: async () => listWorkflows(runtime),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_get_topology"),
      description: toolDescription(
        "Get topology services. GET /topology with optional provider_ids, services, environment, include_empty_deps.",
      ),
      inputSchema: getTopologyInput,
      annotations: READ_ONLY_REMOTE,
      handler: async (args) => getTopology(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_list_applications"),
      description: toolDescription("List topology applications. GET /topology/applications."),
      inputSchema: listApplicationsInput,
      annotations: READ_ONLY_REMOTE,
      handler: async () => listApplications(runtime),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_acknowledge_alert"),
      description: toolDescription(
        "Acknowledge an alert. POST /alerts/enrich?dispose_on_new_alert=true with enrichments status=acknowledged. Omit confirm for a dry-run preview. confirm must be the boolean true to execute.",
      ),
      inputSchema: acknowledgeAlertInput,
      annotations: WRITE_IDEMPOTENT,
      handler: async (args) => acknowledgeAlert(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_resolve_alert"),
      description: toolDescription(
        "Resolve an alert. POST /alerts/enrich?dispose_on_new_alert=true with enrichments status=resolved. Omit confirm for a dry-run preview. confirm must be the boolean true to execute.",
      ),
      inputSchema: resolveAlertInput,
      annotations: WRITE_IDEMPOTENT,
      handler: async (args) => resolveAlert(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_enrich_alert"),
      description: toolDescription(
        "Enrich an alert. POST /alerts/enrich with fingerprint and a string enrichments map. Optional dispose_on_new_alert (API default false). Omit confirm for a dry-run preview.",
      ),
      inputSchema: enrichAlertInput,
      annotations: WRITE_IDEMPOTENT,
      handler: async (args) => enrichAlert(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_update_incident"),
      description: toolDescription(
        "Update an incident with one change. status posts to /incidents/{id}/status with status, comment, and tagged_users. severity posts to /incidents/{id}/severity with severity and comment. fields reads the incident, then PUTs user_generated_name, assignee, user_summary, and same_incident_in_the_past_id merged over the current values. Keep's PUT clears user_summary and same_incident_in_the_past_id when they are omitted. Severity is not sent on PUT. Omit confirm for a dry-run preview.",
      ),
      inputSchema: updateIncidentInput,
      annotations: WRITE_IDEMPOTENT,
      handler: async (args) => updateIncident(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("keep_run_workflow"),
      description: toolDescription(
        "Run a workflow. POST /workflows/{workflow_id}/run with optional type, body, and inputs. type defaults to alert. An alert body may set status and severity. Keep defaults a missing alert status to firing and a missing alert severity to info. Query event_type and event_id replay a stored alert. Incident replay is not implemented. Each run creates a new execution. Omit confirm for a dry-run preview.",
      ),
      inputSchema: runWorkflowInput,
      annotations: WRITE_NON_IDEMPOTENT,
      handler: async (args) => runWorkflow(runtime, args),
    },
    ctx,
  );
  return server;
}

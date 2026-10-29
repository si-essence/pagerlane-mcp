import { z } from "zod";
import { applyWrite, confirmField, type WritePlan } from "./write.js";
import { fixedError } from "./zod-messages.js";
import {
  asToolResult,
  definedBody,
  definedQuery,
  keepArray,
  keepObject,
  keepPath,
  stripProviderSecrets,
} from "./keep-api.js";
import type { Runtime } from "./runtime.js";

export const listProvidersInput = z.object({});

export const listWorkflowsInput = z.object({});

export const getTopologyInput = z.object({
  provider_ids: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe("Optional Keep provider_ids query string."),
  services: z.string().trim().min(1).max(2000).optional(),
  environment: z.string().trim().min(1).max(200).optional(),
  include_empty_deps: z.boolean().optional().describe("Keep default is true."),
});

export const listApplicationsInput = z.object({});

const workflowSeverityError = fixedError("severity must be critical, high, warning, info, or low");
const alertStatusError = fixedError(
  "alert status must be firing, resolved, acknowledged, suppressed, pending, or maintenance",
);
const incidentStatusError = fixedError(
  "incident status must be firing, resolved, acknowledged, merged, or deleted",
);
const workflowStatusError = fixedError(
  "Alert runs accept status firing, resolved, acknowledged, suppressed, pending, or maintenance. Incident runs accept status firing, resolved, acknowledged, merged, or deleted.",
);

const workflowSeverity = z.enum(["critical", "high", "warning", "info", "low"], {
  error: workflowSeverityError,
});
const alertWorkflowStatus = z.enum(
  ["firing", "resolved", "acknowledged", "suppressed", "pending", "maintenance"],
  { error: alertStatusError },
);
const incidentWorkflowStatus = z.enum(["firing", "resolved", "acknowledged", "merged", "deleted"], {
  error: incidentStatusError,
});

const workflowRunBody = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    status: z
      .union([alertWorkflowStatus, incidentWorkflowStatus])
      .optional()
      .describe(
        "AlertStatus or IncidentStatus. Keep defaults a missing alert status to firing and a missing incident status to firing.",
      ),
    severity: workflowSeverity
      .optional()
      .describe(
        "AlertSeverity or IncidentSeverity. Keep defaults a missing alert severity to info. Incident severity has no default.",
      ),
    fingerprint: z.string().trim().min(1).max(255).optional(),
    id: z.string().trim().min(1).max(200).optional(),
    lastReceived: z.string().trim().min(1).max(80).optional(),
    user_generated_name: z.string().trim().min(1).max(500).optional(),
    assignee: z.string().trim().min(1).max(320).optional(),
    user_summary: z.string().trim().min(1).max(10_000).optional(),
  })
  .loose();

export const runWorkflowInput = z
  .object({
    workflow_id: z.string().trim().min(1).max(200).describe("Keep workflow id."),
    type: z
      .enum(["alert", "incident"])
      .optional()
      .describe("Event class for a manual run. Keep defaults an omitted type to alert."),
    body: workflowRunBody
      .optional()
      .describe(
        "Event payload nested as body. Extra keys are sent through. Keep fills a missing alert name, id, and lastReceived.",
      ),
    inputs: z.record(z.string(), z.unknown()).optional(),
    event_type: z
      .enum(["alert", "incident"])
      .optional()
      .describe(
        "Replay query param event_type, used with event_id. Incident replay is not implemented in Keep.",
      ),
    event_id: z.string().trim().min(1).max(200).optional().describe("Replay query param event_id."),
    confirm: confirmField,
  })
  .check(
    z.refine(
      (value) => {
        const status = value.body?.status;
        if (status === undefined) return true;
        const allowed =
          value.type === "incident" ? incidentWorkflowStatus.options : alertWorkflowStatus.options;
        return (allowed as readonly string[]).includes(status);
      },
      { error: workflowStatusError },
    ),
  );

export function planRunWorkflow(args: z.output<typeof runWorkflowInput>): WritePlan {
  const query = definedQuery({
    event_type: args.event_type,
    event_id: args.event_id,
  });
  const body = definedBody({
    type: args.type,
    body: args.body,
    inputs: args.inputs,
  });
  return {
    kind: "request",
    method: "POST",
    path: keepPath("workflows", args.workflow_id, "run"),
    query,
    body: body ?? {},
    summary: `Run workflow ${args.workflow_id} via POST /workflows/{workflow_id}/run.`,
  };
}

export async function listProviders(runtime: Runtime): Promise<Record<string, unknown>> {
  // Installed providers can include credentials in details. Do not cache.
  const raw = await runtime.client.getJson(
    { path: keepPath("providers"), query: undefined, ttlSec: 0 },
    keepObject,
  );
  return asToolResult(stripProviderSecrets(raw));
}

export async function listWorkflows(runtime: Runtime): Promise<Record<string, unknown>> {
  const workflows = await runtime.client.getJson(
    { path: keepPath("workflows"), query: undefined, ttlSec: runtime.cacheTtlSec },
    keepArray,
  );
  return { workflows };
}

export async function getTopology(
  runtime: Runtime,
  args: z.output<typeof getTopologyInput>,
): Promise<Record<string, unknown>> {
  const services = await runtime.client.getJson(
    {
      path: keepPath("topology"),
      query: definedQuery({
        provider_ids: args.provider_ids,
        services: args.services,
        environment: args.environment,
        include_empty_deps: args.include_empty_deps,
      }),
      ttlSec: runtime.cacheTtlSec,
    },
    keepArray,
  );
  return { services };
}

export async function listApplications(runtime: Runtime): Promise<Record<string, unknown>> {
  const applications = await runtime.client.getJson(
    { path: keepPath("topology", "applications"), query: undefined, ttlSec: runtime.cacheTtlSec },
    keepArray,
  );
  return { applications };
}

export async function runWorkflow(
  runtime: Runtime,
  args: z.output<typeof runWorkflowInput>,
): Promise<Record<string, unknown>> {
  return applyWrite(runtime.client, args.confirm, planRunWorkflow(args), keepObject, asToolResult);
}

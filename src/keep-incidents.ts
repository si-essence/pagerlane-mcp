import { z } from "zod";
import { applyWrite, confirmField, type ReadMergePutPlan, type WritePlan } from "./write.js";
import { asToolResult, definedBody, definedQuery, keepObject, keepPath } from "./keep-api.js";
import type { Runtime } from "./runtime.js";
import { ConnectorError } from "./errors.js";
import { fixedError } from "./zod-messages.js";

const limitError = fixedError("limit must be an integer from 1 to 10000");
const offsetError = fixedError("offset must be an integer from 0 to 1000000");
const incidentIdError = fixedError("incident_id must be a UUID");

const incidentIdField = z.uuid({ error: incidentIdError }).describe("Keep incident UUID.");

const incidentStatus = z.enum(["firing", "resolved", "acknowledged", "merged", "deleted"]);
const incidentSeverity = z.enum(["critical", "high", "warning", "info", "low"]);
const incidentSorting = z.enum([
  "creation_time",
  "start_time",
  "last_seen_time",
  "severity",
  "status",
  "alerts_count",
  "-creation_time",
  "-start_time",
  "-last_seen_time",
  "-severity",
  "-status",
  "-alerts_count",
]);

export const listIncidentsInput = z.object({
  limit: z
    .number({ error: limitError })
    .int({ error: limitError })
    .min(1, { error: limitError })
    .max(10_000, { error: limitError })
    .optional()
    .describe("Page size. Keep default is 25."),
  offset: z
    .number({ error: offsetError })
    .int({ error: offsetError })
    .min(0, { error: offsetError })
    .max(1_000_000, { error: offsetError })
    .optional(),
  sorting: incidentSorting.optional().describe("Keep IncidentSorting value."),
  cel: z.string().trim().min(1).max(10_000).optional().describe("CEL filter."),
  candidate: z.boolean().optional(),
  predicted: z.boolean().optional(),
  status: z.array(incidentStatus).optional(),
  severity: z.array(incidentSeverity).optional(),
  assignees: z.array(z.string().trim().min(1).max(200)).optional(),
  sources: z.array(z.string().trim().min(1).max(200)).optional(),
  affected_services: z.array(z.string().trim().min(1).max(200)).optional(),
});

export const getIncidentInput = z.object({
  incident_id: incidentIdField,
  include_alerts: z.boolean().optional().describe("If true, also GET /incidents/{id}/alerts."),
  alerts_limit: z
    .number({ error: limitError })
    .int({ error: limitError })
    .min(1, { error: limitError })
    .max(10_000, { error: limitError })
    .optional(),
  alerts_offset: z
    .number({ error: offsetError })
    .int({ error: offsetError })
    .min(0, { error: offsetError })
    .max(1_000_000, { error: offsetError })
    .optional(),
});

const pastIncidentError = fixedError("same_incident_in_the_past_id must be a UUID or null");
const fieldsChangeError = fixedError(
  "fields change must include user_generated_name, assignee, user_summary, or same_incident_in_the_past_id",
);

const incidentComment = z.string().trim().min(1).max(10_000).optional();

const incidentStatusChange = z.object({
  kind: z.literal("status"),
  status: incidentStatus,
  comment: incidentComment,
  tagged_users: z.array(z.string().trim().min(1).max(320)).optional(),
});

const incidentSeverityChange = z.object({
  kind: z.literal("severity"),
  severity: incidentSeverity,
  comment: incidentComment,
});

const incidentFieldsChange = z
  .object({
    kind: z.literal("fields"),
    user_generated_name: z.string().trim().min(1).max(500).optional(),
    assignee: z.string().trim().min(1).max(320).optional(),
    user_summary: z.string().trim().min(1).max(10_000).optional(),
    same_incident_in_the_past_id: z
      .uuid({ error: pastIncidentError })
      .nullable()
      .optional()
      .describe("UUID to link, or null to clear the link."),
  })
  .check(
    z.refine(
      (value) =>
        value.user_generated_name !== undefined ||
        value.assignee !== undefined ||
        value.user_summary !== undefined ||
        value.same_incident_in_the_past_id !== undefined,
      { error: fieldsChangeError },
    ),
  );

const incidentChange = z.discriminatedUnion("kind", [
  incidentStatusChange,
  incidentSeverityChange,
  incidentFieldsChange,
]);

export const updateIncidentInput = z.object({
  incident_id: incidentIdField,
  change: incidentChange.describe(
    "One change. status posts to /status. severity posts to /severity. fields are merged onto the current incident and then PUT.",
  ),
  confirm: confirmField,
});

/** Fields Keep's PUT writes even when the request omits them. */
const incidentPreservedFields = z.object({
  user_generated_name: z.string().nullable(),
  assignee: z.string().nullable(),
  user_summary: z.string().nullable(),
  same_incident_in_the_past_id: z.uuid().nullable(),
});

type IncidentPreservedFields = z.infer<typeof incidentPreservedFields>;
type IncidentFieldsChange = z.output<typeof incidentFieldsChange>;

function mergeIncidentFields(
  current: IncidentPreservedFields,
  change: IncidentFieldsChange,
): Record<string, unknown> {
  return {
    user_generated_name:
      change.user_generated_name !== undefined
        ? change.user_generated_name
        : current.user_generated_name,
    assignee: change.assignee !== undefined ? change.assignee : current.assignee,
    user_summary: change.user_summary !== undefined ? change.user_summary : current.user_summary,
    same_incident_in_the_past_id:
      change.same_incident_in_the_past_id !== undefined
        ? change.same_incident_in_the_past_id
        : current.same_incident_in_the_past_id,
  };
}

function planFieldUpdate(
  incidentId: string,
  change: IncidentFieldsChange,
): ReadMergePutPlan<IncidentPreservedFields> {
  const previewBody = definedBody({
    user_generated_name: change.user_generated_name,
    assignee: change.assignee,
    user_summary: change.user_summary,
    same_incident_in_the_past_id: change.same_incident_in_the_past_id,
  });
  if (previewBody === undefined) {
    throw new ConnectorError("input", "Provide at least one incident field.");
  }
  return {
    kind: "read-merge-put",
    path: keepPath("incidents", incidentId),
    previewBody,
    summary: `Update incident ${incidentId} fields via PUT /incidents/{id}. Unspecified user_summary and same_incident_in_the_past_id will be preserved by reading the current incident first.`,
    currentSchema: incidentPreservedFields,
    merge: (current) => mergeIncidentFields(current, change),
  };
}

export function planUpdateIncident(
  args: z.output<typeof updateIncidentInput>,
): WritePlan<IncidentPreservedFields> {
  const change = args.change;
  if (change.kind === "status") {
    return {
      kind: "request",
      method: "POST",
      path: keepPath("incidents", args.incident_id, "status"),
      query: undefined,
      body: definedBody({
        status: change.status,
        comment: change.comment,
        tagged_users: change.tagged_users,
      }),
      summary: `Change incident ${args.incident_id} status to ${change.status}.`,
    };
  }
  if (change.kind === "severity") {
    return {
      kind: "request",
      method: "POST",
      path: keepPath("incidents", args.incident_id, "severity"),
      query: undefined,
      body: definedBody({
        severity: change.severity,
        comment: change.comment,
      }),
      summary: `Change incident ${args.incident_id} severity to ${change.severity}.`,
    };
  }
  return planFieldUpdate(args.incident_id, change);
}

export async function listIncidents(
  runtime: Runtime,
  args: z.output<typeof listIncidentsInput>,
): Promise<Record<string, unknown>> {
  const data = await runtime.client.getJson(
    {
      path: keepPath("incidents"),
      query: definedQuery({
        limit: args.limit ?? 25,
        offset: args.offset ?? 0,
        sorting: args.sorting,
        cel: args.cel,
        candidate: args.candidate,
        predicted: args.predicted,
        status: args.status,
        severity: args.severity,
        assignees: args.assignees,
        sources: args.sources,
        affected_services: args.affected_services,
      }),
      ttlSec: runtime.cacheTtlSec,
    },
    keepObject,
  );
  return asToolResult(data);
}

export async function getIncident(
  runtime: Runtime,
  args: z.output<typeof getIncidentInput>,
): Promise<Record<string, unknown>> {
  const incident = await runtime.client.getJson(
    {
      path: keepPath("incidents", args.incident_id),
      query: undefined,
      ttlSec: runtime.cacheTtlSec,
    },
    keepObject,
  );
  if (args.include_alerts !== true) return { incident };
  const alerts = await runtime.client.getJson(
    {
      path: keepPath("incidents", args.incident_id, "alerts"),
      query: definedQuery({
        limit: args.alerts_limit ?? 25,
        offset: args.alerts_offset ?? 0,
      }),
      ttlSec: runtime.cacheTtlSec,
    },
    keepObject,
  );
  return { incident, alerts };
}

export async function updateIncident(
  runtime: Runtime,
  args: z.output<typeof updateIncidentInput>,
): Promise<Record<string, unknown>> {
  return applyWrite(
    runtime.client,
    args.confirm,
    planUpdateIncident(args),
    keepObject,
    asToolResult,
  );
}

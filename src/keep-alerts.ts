import { z } from "zod";
import { applyWrite, confirmField, type WritePlan } from "./write.js";
import {
  asToolResult,
  definedBody,
  definedQuery,
  keepArray,
  keepObject,
  keepPath,
} from "./keep-api.js";
import type { Runtime } from "./runtime.js";
import { ConnectorError } from "./errors.js";
import { fixedError } from "./zod-messages.js";

const fingerprintError = fixedError("fingerprint must be 1-255 characters");
const limitError = fixedError("limit must be an integer from 1 to 10000");
const offsetError = fixedError("offset must be an integer from 0 to 1000000");

const fingerprintField = z
  .string({ error: fingerprintError })
  .trim()
  .min(1, { error: fingerprintError })
  .max(255, { error: fingerprintError })
  .describe("Keep alert fingerprint.");

export const listAlertsInput = z.object({
  limit: z
    .number({ error: limitError })
    .int({ error: limitError })
    .min(1, { error: limitError })
    .max(10_000, { error: limitError })
    .optional()
    .describe("Maximum alerts to return. Keep default is 1000."),
});

export const searchAlertsInput = z.object({
  cel: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .optional()
    .describe("CEL filter, for example status == 'firing'."),
  limit: z
    .number({ error: limitError })
    .int({ error: limitError })
    .min(1, { error: limitError })
    .max(10_000, { error: limitError })
    .optional(),
  offset: z
    .number({ error: offsetError })
    .int({ error: offsetError })
    .min(0, { error: offsetError })
    .max(1_000_000, { error: offsetError })
    .optional(),
  sort_by: z.string().trim().min(1).max(120).optional(),
  sort_dir: z.enum(["asc", "desc", "ASC", "DESC"]).optional(),
});

export const getAlertInput = z.object({
  fingerprint: fingerprintField,
});

const enrichmentsField = z
  .record(z.string().min(1), z.string())
  .describe("String enrichment map. Keep's EnrichAlertRequestBody uses dict[str, str].");

export const acknowledgeAlertInput = z.object({
  fingerprint: fingerprintField,
  dispose_on_new_alert: z
    .boolean()
    .optional()
    .describe("Keep query flag. Defaults to true so a new occurrence can drop this status."),
  confirm: confirmField,
});

export const resolveAlertInput = z.object({
  fingerprint: fingerprintField,
  dispose_on_new_alert: z
    .boolean()
    .optional()
    .describe("Keep query flag. Defaults to true so a new occurrence can drop this status."),
  confirm: confirmField,
});

export const enrichAlertInput = z.object({
  fingerprint: fingerprintField,
  enrichments: enrichmentsField,
  dispose_on_new_alert: z.boolean().optional().describe("Keep query flag. API default is false."),
  confirm: confirmField,
});

function statusEnrichments(status: "acknowledged" | "resolved"): Record<string, string> {
  return {
    status,
    dismissed: "false",
    dismissUntil: "",
  };
}

function planEnrich(input: {
  fingerprint: string;
  enrichments: Record<string, string>;
  dispose_on_new_alert: boolean;
  summary: string;
}): WritePlan {
  if (Object.keys(input.enrichments).length === 0) {
    throw new ConnectorError("input", "enrichments must include at least one field.");
  }
  return {
    kind: "request",
    method: "POST",
    path: keepPath("alerts", "enrich"),
    query: definedQuery({ dispose_on_new_alert: input.dispose_on_new_alert }),
    body: {
      fingerprint: input.fingerprint,
      enrichments: input.enrichments,
    },
    summary: input.summary,
  };
}

export function planAcknowledgeAlert(args: z.output<typeof acknowledgeAlertInput>): WritePlan {
  return planEnrich({
    fingerprint: args.fingerprint,
    enrichments: statusEnrichments("acknowledged"),
    dispose_on_new_alert: args.dispose_on_new_alert ?? true,
    summary: `Acknowledge alert ${args.fingerprint} via POST /alerts/enrich with status=acknowledged.`,
  });
}

export function planResolveAlert(args: z.output<typeof resolveAlertInput>): WritePlan {
  return planEnrich({
    fingerprint: args.fingerprint,
    enrichments: statusEnrichments("resolved"),
    dispose_on_new_alert: args.dispose_on_new_alert ?? true,
    summary: `Resolve alert ${args.fingerprint} via POST /alerts/enrich with status=resolved.`,
  });
}

export function planEnrichAlert(args: z.output<typeof enrichAlertInput>): WritePlan {
  return planEnrich({
    fingerprint: args.fingerprint,
    enrichments: args.enrichments,
    dispose_on_new_alert: args.dispose_on_new_alert ?? false,
    summary: `Enrich alert ${args.fingerprint} via POST /alerts/enrich.`,
  });
}

export async function listAlerts(
  runtime: Runtime,
  args: z.output<typeof listAlertsInput>,
): Promise<Record<string, unknown>> {
  const alerts = await runtime.client.getJson(
    {
      path: keepPath("alerts"),
      query: definedQuery({ limit: args.limit ?? 1000 }),
      ttlSec: runtime.cacheTtlSec,
    },
    keepArray,
  );
  return { alerts };
}

export async function searchAlerts(
  runtime: Runtime,
  args: z.output<typeof searchAlertsInput>,
): Promise<Record<string, unknown>> {
  const body = definedBody({
    cel: args.cel,
    limit: args.limit,
    offset: args.offset,
    sort_by: args.sort_by,
    sort_dir: args.sort_dir,
  });
  const data = await runtime.client.postJson(
    {
      path: keepPath("alerts", "query"),
      query: undefined,
      body: body ?? {},
      ttlSec: runtime.cacheTtlSec,
      invalidate: false,
    },
    keepObject,
  );
  return asToolResult(data);
}

export async function getAlert(
  runtime: Runtime,
  args: z.output<typeof getAlertInput>,
): Promise<Record<string, unknown>> {
  const alert = await runtime.client.getJson(
    {
      path: keepPath("alerts", args.fingerprint),
      query: undefined,
      ttlSec: runtime.cacheTtlSec,
    },
    keepObject,
  );
  return { alert };
}

export async function acknowledgeAlert(
  runtime: Runtime,
  args: z.output<typeof acknowledgeAlertInput>,
): Promise<Record<string, unknown>> {
  return applyWrite(
    runtime.client,
    args.confirm,
    planAcknowledgeAlert(args),
    keepObject,
    asToolResult,
  );
}

export async function resolveAlert(
  runtime: Runtime,
  args: z.output<typeof resolveAlertInput>,
): Promise<Record<string, unknown>> {
  return applyWrite(runtime.client, args.confirm, planResolveAlert(args), keepObject, asToolResult);
}

export async function enrichAlert(
  runtime: Runtime,
  args: z.output<typeof enrichAlertInput>,
): Promise<Record<string, unknown>> {
  return applyWrite(runtime.client, args.confirm, planEnrichAlert(args), keepObject, asToolResult);
}

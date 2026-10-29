import type { ZodType } from "zod";
import { z } from "zod";
import { fixedError } from "./zod-messages.js";
import type { HttpClient, QueryMap } from "./http.js";

const confirmError = fixedError("confirm must be the boolean true");

/** The only accepted confirm value is the boolean `true`. `false` and `"true"` fail Zod. */
export const confirmField = z
  .literal(true, { error: confirmError })
  .optional()
  .describe(
    "Set to the boolean true to execute the write. Omit this field for a dry-run preview. false and the string true are rejected.",
  );

export interface RequestWritePlan {
  readonly kind: "request";
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly query: QueryMap | undefined;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly summary: string;
}

/** GET the path, merge with a pure function, then PUT. The GET runs only on execute. */
export interface ReadMergePutPlan<TCurrent> {
  readonly kind: "read-merge-put";
  readonly path: string;
  readonly previewBody: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly currentSchema: ZodType<TCurrent>;
  readonly merge: (current: TCurrent) => Readonly<Record<string, unknown>>;
}

export type WritePlan<TCurrent = unknown> = RequestWritePlan | ReadMergePutPlan<TCurrent>;

export interface WritePreview {
  readonly dryRun: true;
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly query: QueryMap | undefined;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly summary: string;
}

export type WriteDecision =
  | { readonly kind: "preview"; readonly payload: Record<string, unknown> }
  | { readonly kind: "execute" };

export function previewWrite<TCurrent>(plan: WritePlan<TCurrent>): Record<string, unknown> {
  if (plan.kind === "read-merge-put") {
    return {
      dryRun: true,
      method: "PUT",
      path: plan.path,
      body: plan.previewBody,
      summary: plan.summary,
    };
  }
  const payload: Record<string, unknown> = {
    dryRun: true,
    method: plan.method,
    path: plan.path,
    summary: plan.summary,
  };
  if (plan.query !== undefined) payload["query"] = plan.query;
  if (plan.body !== undefined) payload["body"] = plan.body;
  return payload;
}

export function decideWrite<TCurrent>(
  confirm: true | undefined,
  plan: WritePlan<TCurrent>,
): WriteDecision {
  if (confirm === true) return { kind: "execute" };
  return { kind: "preview", payload: previewWrite(plan) };
}

export async function runWrite<T>(
  client: HttpClient,
  plan: RequestWritePlan,
  schema: ZodType<T>,
): Promise<T> {
  const request = {
    path: plan.path,
    query: plan.query,
    body: plan.body,
    ttlSec: 0,
    invalidate: true,
  };
  if (plan.method === "POST") return client.postJson(request, schema);
  return client.putJson(request, schema);
}

async function runReadMergePut<TCurrent>(
  client: HttpClient,
  plan: ReadMergePutPlan<TCurrent>,
  schema: ZodType,
): Promise<unknown> {
  const current = await client.getJson(
    { path: plan.path, query: undefined, ttlSec: 0, redactResponse: false },
    plan.currentSchema,
  );
  return client.putJson(
    {
      path: plan.path,
      query: undefined,
      body: plan.merge(current),
      ttlSec: 0,
      invalidate: true,
    },
    schema,
  );
}

export async function applyWrite<TCurrent>(
  client: HttpClient,
  confirm: true | undefined,
  plan: WritePlan<TCurrent>,
  schema: ZodType,
  wrap: (data: unknown) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const decision = decideWrite(confirm, plan);
  if (decision.kind === "preview") return decision.payload;
  if (plan.kind === "request") return wrap(await runWrite(client, plan, schema));
  return wrap(await runReadMergePut(client, plan, schema));
}

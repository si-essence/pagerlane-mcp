import { z } from "zod";
import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";

export const keepObject = z.record(z.string(), z.unknown());
export const keepArray = z.array(z.unknown());
export const keepObjectOrArray = z.union([keepObject, keepArray]);

const PROVIDER_SECRET_KEYS = new Set([
  "authentication",
  "api_key",
  "apikey",
  "api-key",
  "access_token",
  "configuration_key",
  "configurationkey",
  "config",
  "credentials",
  "details",
  "password",
  "secret",
  "secrets",
  "token",
]);

export function keepPath(...segments: readonly string[]): string {
  if (segments.length === 0) {
    throw new ConnectorError("input", "Request path must be a relative path.");
  }
  const encoded: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    encoded.push(encodeURIComponent(trimmed));
  }
  return encoded.join("/");
}

export function definedQuery(
  record: Readonly<Record<string, QueryValue | undefined>>,
): QueryMap | undefined {
  const out: Record<string, QueryValue> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function definedBody(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function asToolResult(parsed: unknown): Record<string, unknown> {
  const record = keepObject.safeParse(parsed);
  if (record.success) return record.data;
  return { data: parsed };
}

export function stripProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProviderSecrets);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PROVIDER_SECRET_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripProviderSecrets(entry);
  }
  return out;
}

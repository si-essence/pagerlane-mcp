import { loadConfig } from "../src/config.js";
import { API_KEY_HEADER } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const KEY = "super-secret/key+value=99";
export const BASE = "https://keep.test";
export const INCIDENT_ID = "c2509cb3-6168-4347-b83b-a41da9df2d5b";

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { KEEP_API_URL: BASE, KEEP_API_KEY: KEY, ...extra };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(env(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | null;
  body: unknown;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  let body: unknown;
  if (init?.body === undefined) body = undefined;
  else if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
    }
  } else body = init.body;
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    apiKey: new Headers(init?.headers).get(API_KEY_HEADER),
    body,
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

import type { ZodType } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactUnknown, stripUrls } from "./redact.js";

export const API_KEY_HEADER = "X-API-KEY";
const MAX_BODY = 1_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;

export interface JsonGet {
  path: string;
  query: QueryMap | undefined;
  ttlSec: number;
  /**
   * When false, return the parsed body without redaction and do not cache it.
   * Use this only for a value that is written back and never returned to the caller.
   */
  redactResponse?: boolean;
}

export interface JsonWrite {
  path: string;
  query: QueryMap | undefined;
  body: unknown;
  ttlSec: number;
  invalidate: boolean;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  apiKey: Secret | undefined;
  label: string;
}

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly apiKey: Secret | undefined;
  private readonly label: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.apiKey = options.apiKey;
    this.label = options.label;
  }

  async getJson<T>(request: JsonGet, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "GET",
        path: request.path,
        query: request.query,
        bodyText: undefined,
        ttlSec: request.ttlSec,
        invalidate: false,
        ...(request.redactResponse === false ? { redactResponse: false } : {}),
      },
      schema,
    );
  }

  async postJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "POST",
        path: request.path,
        query: request.query,
        bodyText: this.serializeBody(request.body),
        ttlSec: request.ttlSec,
        invalidate: request.invalidate,
      },
      schema,
    );
  }

  async putJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "PUT",
        path: request.path,
        query: request.query,
        bodyText: this.serializeBody(request.body),
        ttlSec: request.ttlSec,
        invalidate: request.invalidate,
      },
      schema,
    );
  }

  private async exchange<T>(
    request: {
      method: "GET" | "POST" | "PUT";
      path: string;
      query: QueryMap | undefined;
      bodyText: string | undefined;
      ttlSec: number;
      invalidate: boolean;
      redactResponse?: boolean;
    },
    schema: ZodType<T>,
  ): Promise<T> {
    const redactResponse = request.redactResponse !== false;
    const url = this.buildUrl(request.path, request.query);
    const cacheKey = `${request.method} ${url.origin}${url.pathname}${url.search} ${request.bodyText ?? ""}`;
    if (request.ttlSec > 0 && !request.invalidate && redactResponse) {
      const cached = this.readCache(cacheKey, schema);
      if (cached !== undefined) return cached;
    }

    if (this.apiKey === undefined) {
      throw new ConnectorError(
        "config",
        "KEEP_API_KEY is not set. Add it to the environment before calling the upstream API.",
      );
    }

    this.limiter.acquire();
    const response = await this.send(url, request.method, request.bodyText);
    const text = await readLimited(response, this.label);
    if (!response.ok) {
      throw this.httpError(response, text);
    }
    if (/<!doctype html|<html[\s>]/i.test(text)) {
      throw new ConnectorError(
        "upstream",
        `${this.label} HTTP ${response.status}: the service returned an error page instead of JSON.`,
      );
    }
    const json = parseJsonBody(text, response.status, this.label);
    const accepted = this.accept(cacheKey, request.ttlSec, schema, json, redactResponse);
    if (request.invalidate) this.cache.clear();
    return accepted;
  }

  private serializeBody(body: unknown): string | undefined {
    if (body === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      throw new ConnectorError("input", "Request body could not be serialized as JSON.");
    }
    if (text.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    this.assertNoSecret(text);
    return text;
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  private accept<T>(
    cacheKey: string,
    ttlSec: number,
    schema: ZodType<T>,
    json: unknown,
    redactResponse: boolean,
  ): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError(
        "upstream",
        `${this.label} response did not match the expected shape.`,
      );
    }
    // A read-before-write must echo the stored text. Redacting it would persist the marker.
    if (!redactResponse) return parsed.data;
    const safe = schema.safeParse(redactUnknown(parsed.data, this.secrets));
    if (!safe.success) {
      throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
    }
    if (ttlSec > 0) this.cache.set(cacheKey, safe.data, ttlSec);
    return safe.data;
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    this.assertNoSecret(path);
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    this.assertNoSecret(`${url.pathname}${url.search}`);
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text);
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text);
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error("Refusing to place a secret in the request URL.");
        throw new ConnectorError("config", "Refusing to place a secret in the request URL.");
      }
    }
  }

  private async send(
    url: URL,
    method: "GET" | "POST" | "PUT",
    bodyText: string | undefined,
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("user-agent", this.userAgent);
    if (this.apiKey !== undefined) headers.set(API_KEY_HEADER, this.apiKey);
    if (bodyText !== undefined) headers.set("content-type", "application/json");
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (bodyText !== undefined) init.body = bodyText;
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.secrets);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("upstream", `${this.label} request failed: ${safe}`);
    }
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = publicSnippet(text, this.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    if (response.status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (response.status === 429) {
      return new ConnectorError(
        "rate_limit",
        `${this.label} HTTP 429${detail}`,
        retryAfterSeconds(response),
      );
    }
    this.logger.error(`${this.label} HTTP ${response.status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${response.status}${detail}`);
  }
}

function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function parseJsonBody(text: string, status: number, label: string): unknown {
  if (text.trim().length === 0) {
    throw new ConnectorError("upstream", `${label} returned an empty body (HTTP ${status}).`);
  }
  try {
    return parseJson(text);
  } catch {
    throw new ConnectorError("upstream", `${label} returned non-JSON (HTTP ${status}).`);
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}

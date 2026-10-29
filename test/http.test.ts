import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { API_KEY_HEADER } from "../src/http.js";
import { createRuntime } from "../src/runtime.js";
import { BASE, KEY, env, requestUrl, runtimeFor } from "./harness.js";

const recordSchema = z.object({ id: z.string(), title: z.string() });

describe("HttpClient", () => {
  it("sends the key as a header, caches the parsed body, and does not put the key in the url", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      urls.push(requestUrl(input));
      return Promise.resolve(Response.json({ id: "rec-1", title: "Widget" }));
    });
    let now = 0;
    const runtime = runtimeFor(fetchImpl, { KEEP_CACHE_TTL_SEC: "30" }, () => now);
    const first = await runtime.client.getJson(
      { path: "lookup", query: { q: "widget" }, ttlSec: 30 },
      recordSchema,
    );
    const second = await runtime.client.getJson(
      { path: "lookup", query: { q: "widget" }, ttlSec: 30 },
      recordSchema,
    );
    expect(first).toEqual({ id: "rec-1", title: "Widget" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get(API_KEY_HEADER)).toBe(KEY);
    expect(urls.join("\n")).not.toContain(KEY);
    expect(urls[0]).toContain("/lookup?q=widget");
    now = 31_000;
    await runtime.client.getJson(
      { path: "lookup", query: { q: "widget" }, ttlSec: 30 },
      recordSchema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not spend the rate limit on a cache hit and blocks the next miss", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "1", title: "A" })),
    );
    const runtime = runtimeFor(
      fetchImpl,
      { KEEP_PER_MINUTE: "1", KEEP_CACHE_TTL_SEC: "60" },
      () => 0,
    );
    await runtime.client.getJson({ path: "lookup", query: { q: "a" }, ttlSec: 60 }, recordSchema);
    await runtime.client.getJson({ path: "lookup", query: { q: "a" }, ttlSec: 60 }, recordSchema);
    await expect(
      runtime.client.getJson({ path: "lookup", query: { q: "b" }, ttlSec: 60 }, recordSchema),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts JSON, skips the cache, and clears cached GETs after a write", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return Promise.resolve(Response.json({ status: "ok" }));
      }
      return Promise.resolve(Response.json({ id: "1", title: "A" }));
    });
    const runtime = runtimeFor(fetchImpl, { KEEP_CACHE_TTL_SEC: "60" }, () => 0);
    await runtime.client.getJson({ path: "alerts", query: undefined, ttlSec: 60 }, recordSchema);
    await runtime.client.getJson({ path: "alerts", query: undefined, ttlSec: 60 }, recordSchema);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const posted = await runtime.client.postJson(
      {
        path: "alerts/enrich",
        query: { dispose_on_new_alert: true },
        body: { fingerprint: "fp-1", enrichments: { status: "acknowledged" } },
        ttlSec: 0,
        invalidate: true,
      },
      z.object({ status: z.string() }),
    );
    expect(posted).toEqual({ status: "ok" });
    const postInit = fetchImpl.mock.calls[1]?.[1];
    expect(postInit?.method).toBe("POST");
    expect(new Headers(postInit?.headers).get(API_KEY_HEADER)).toBe(KEY);
    expect(new Headers(postInit?.headers).get("content-type")).toBe("application/json");
    expect(postInit?.body).toBe(
      JSON.stringify({ fingerprint: "fp-1", enrichments: { status: "acknowledged" } }),
    );
    expect(requestUrl(fetchImpl.mock.calls[1]?.[0] ?? "")).toContain(
      "/alerts/enrich?dispose_on_new_alert=true",
    );
    await runtime.client.getJson({ path: "alerts", query: undefined, ttlSec: 60 }, recordSchema);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("redacts a secret that the upstream body or a network error tried to echo", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error(`connect failed ${KEY} ${encodeURIComponent(KEY)}`);
    });
    const runtime = createRuntime(loadConfig(env(), []), {
      fetchImpl,
      logger: { info: () => undefined, error: (message) => logs.push(message) },
    });
    await expect(
      runtime.client.getJson({ path: "lookup", query: { q: "widget" }, ttlSec: 0 }, recordSchema),
    ).rejects.toThrow(ConnectorError);
    try {
      await runtime.client.getJson(
        { path: "lookup", query: { q: "widget" }, ttlSec: 0 },
        recordSchema,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain(encodeURIComponent(KEY));
      expect(error.message).toContain("[redacted]");
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("fails closed when the api key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "1", title: "A" })),
    );
    const runtime = createRuntime(loadConfig({ KEEP_API_URL: BASE }, []), { fetchImpl });
    await expect(
      runtime.client.getJson({ path: "lookup", query: { q: "widget" }, ttlSec: 0 }, recordSchema),
    ).rejects.toMatchObject({ code: "config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to put the api key in the query string", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "1", title: "A" })),
    );
    const runtime = runtimeFor(fetchImpl);
    await expect(
      runtime.client.getJson({ path: "lookup", query: { q: KEY }, ttlSec: 0 }, recordSchema),
    ).rejects.toThrow(/request URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps timeout, not found, and too many requests", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing abort signal"));
          return;
        }
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    const timeoutRuntime = runtimeFor(hanging, { KEEP_TIMEOUT_MS: "100" });
    await expect(
      timeoutRuntime.client.getJson(
        { path: "lookup", query: { q: "widget" }, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    const notFound = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("missing", { status: 404 })),
    );
    await expect(
      runtimeFor(notFound).client.getJson(
        { path: "lookup", query: { q: "widget" }, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const limited = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(`slow ${KEY}`, { status: 429, headers: { "retry-after": "4" } }),
      ),
    );
    try {
      await runtimeFor(limited).client.getJson(
        { path: "lookup", query: { q: "widget" }, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("rate_limit");
      expect(error.retryAfterSeconds).toBe(4);
      expect(error.message).not.toContain(KEY);
    }
  });
});

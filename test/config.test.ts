import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { BASE, KEY, env } from "./harness.js";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

describe("loadConfig", () => {
  it("requires KEEP_API_URL and applies defaults", () => {
    const config = loadConfig(env({ KEEP_API_KEY: undefined }), []);
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe(BASE);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("rejects a missing KEEP_API_URL", () => {
    const message = messageOf(catchError(() => loadConfig({}, [])));
    expect(message).toContain("KEEP_API_URL");
    expect(message).toContain("required");
  });

  it("rejects an invalid KEEP_API_URL without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ KEEP_API_URL: "not a url", KEEP_API_KEY: KEY }, [])),
    );
    expect(message).toContain("KEEP_API_URL");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("not a url");
  });

  it("lets --http override the transport", () => {
    expect(loadConfig(env({ MCP_TRANSPORT: "stdio" }), ["node", "app", "--http"]).transport).toBe(
      "http",
    );
    expect(loadConfig(env({ MCP_TRANSPORT: "http" }), []).transport).toBe("http");
  });

  it("reports invalid fields without the rejected value or the api key", () => {
    let caught: unknown;
    try {
      loadConfig(env({ KEEP_API_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" }), []);
    } catch (error) {
      caught = error;
    }
    const message = messageOf(caught);
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short api key without echoing it", () => {
    let caught: unknown;
    try {
      loadConfig(env({ KEEP_API_KEY: "short" }), []);
    } catch (error) {
      caught = error;
    }
    const message = messageOf(caught);
    expect(message).toContain("KEEP_API_KEY");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the api key", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ KEEP_API_KEY: KEY, KEEP_API_URL: `https://example.invalid/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() => loadConfig(env({ KEEP_API_KEY: KEY, KEEP_CONTACT: KEY }), [])),
    );
    expect(inContact).toContain("KEEP_CONTACT");
    expect(inContact).not.toContain(KEY);
  });

  it("rejects userinfo and query strings on the base url", () => {
    const userinfo = messageOf(
      catchError(() => loadConfig({ KEEP_API_URL: "https://user:pass@example.invalid" }, [])),
    );
    expect(userinfo).toContain("userinfo");
    expect(userinfo).not.toContain("pass");

    const query = messageOf(
      catchError(() =>
        loadConfig({ KEEP_API_URL: `https://example.invalid/v1?api_key=${KEY}` }, []),
      ),
    );
    expect(query).toContain("KEEP_API_URL");
    expect(query).not.toContain(KEY);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

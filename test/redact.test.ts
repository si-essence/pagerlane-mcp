import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { KEY, env, requestUrl } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const ENCODED = encodeURIComponent(KEY);

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and bearer tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("redacts nested strings and object keys", () => {
    const cleaned = JSON.stringify(redactUnknown({ [KEY]: [{ title: `see ${KEY}` }] }, [KEY]));
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("[redacted]");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the api key out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    const rawSuccess = { fingerprint: "fp-1", title: `hello ${KEY}` };
    const rawFailure = `connect failed ${KEY} ${ENCODED}`;
    expect(JSON.stringify(rawSuccess)).toContain(KEY);
    expect(rawFailure).toContain(KEY);

    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      assertNoKey("request url", url);
      const header = new Headers(init?.headers).get("x-api-key");
      expect(header).toBe(KEY);
      call += 1;
      if (call === 1) return Promise.resolve(Response.json(rawSuccess));
      return Promise.reject(new Error(rawFailure));
    });

    const runtime = createRuntime(loadConfig(env({ KEEP_CACHE_TTL_SEC: "0" }), []), {
      fetchImpl,
      logger: createLogger([KEY], (line) => {
        logs.push(line);
      }),
    });
    const { client, close } = await connectServer(runtime);
    try {
      const ok = readToolText(
        await client.callTool({ name: "keep_get_alert", arguments: { fingerprint: "fp-1" } }),
      );
      const bad = readToolText(
        await client.callTool({ name: "keep_get_alert", arguments: { fingerprint: "fp-2" } }),
      );
      const leakedQuery = readToolText(
        await client.callTool({ name: "keep_get_alert", arguments: { fingerprint: KEY } }),
      );
      const invalid = readToolText(
        await client.callTool({
          name: "keep_acknowledge_alert",
          arguments: { fingerprint: "fp-1", confirm: false },
        }),
      );

      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("[redacted]");
      assertNoKey("success output", ok.text);

      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("[redacted]");
      assertNoKey("error output", bad.text);

      expect(leakedQuery.isError).toBe(true);
      assertNoKey("query echo", leakedQuery.text);

      expect(invalid.isError).toBe(true);
      assertNoKey("validation error", invalid.text);

      expect(logs.length).toBeGreaterThan(0);
      assertNoKey("logs", logs.join("\n"));
      assertNoKey("stderr", consoleLines.join("\n"));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      await close();
    }
  });
});

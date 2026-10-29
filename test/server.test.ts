import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME, CONNECTOR_TITLE } from "../src/constants.js";
import { acknowledgeAlertInput, enrichAlertInput, resolveAlertInput } from "../src/keep-alerts.js";
import { runWorkflowInput } from "../src/keep-catalog.js";
import { updateIncidentInput } from "../src/keep-incidents.js";
import { confirmField } from "../src/write.js";
import { jsonFetch, INCIDENT_ID, KEY, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = [
  "keep_list_alerts",
  "keep_search_alerts",
  "keep_get_alert",
  "keep_list_incidents",
  "keep_get_incident",
  "keep_list_providers",
  "keep_list_workflows",
  "keep_get_topology",
  "keep_list_applications",
  "keep_acknowledge_alert",
  "keep_resolve_alert",
  "keep_enrich_alert",
  "keep_update_incident",
  "keep_run_workflow",
] as const;

function parseObject(text: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

describe("pagerlane-mcp tools", () => {
  it("publishes Pagerlane and the keep_ tools", async () => {
    const runtime = runtimeFor(() => Promise.resolve(new Response("unused")));
    const { client, close } = await connectServer(runtime);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: "pagerlane-mcp",
        title: "Pagerlane",
      });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });

  it("keeps the package name aligned with package.json", () => {
    const pkg = z
      .object({
        name: z.string(),
        bin: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe("pagerlane-mcp");
    expect(pkg.name).toBe(CONNECTOR_NAME);
    expect(CONNECTOR_TITLE).toBe("Pagerlane");
    expect(pkg.bin).toEqual({ "pagerlane-mcp": "dist/index.js" });
  });

  it("lists alerts with GET /alerts and the X-API-KEY header", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json([{ fingerprint: "fp-1", name: "cpu", status: "firing" }]),
    );
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({ name: "keep_list_alerts", arguments: { limit: 10 } }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({
        alerts: [{ fingerprint: "fp-1", name: "cpu", status: "firing" }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe("https://keep.test/alerts?limit=10");
      expect(calls[0]?.apiKey).toBe(KEY);
    } finally {
      await close();
    }
  });

  it("searches alerts with POST /alerts/query", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({ limit: 5, offset: 0, count: 1, results: [{ fingerprint: "fp-1" }] }),
    );
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_search_alerts",
          arguments: { cel: "status == 'firing'", limit: 5 },
        }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({
        limit: 5,
        offset: 0,
        count: 1,
        results: [{ fingerprint: "fp-1" }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toBe("https://keep.test/alerts/query");
      expect(calls[0]?.apiKey).toBe(KEY);
      expect(calls[0]?.body).toEqual({ cel: "status == 'firing'", limit: 5 });
    } finally {
      await close();
    }
  });

  it("gets an alert by fingerprint", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({ fingerprint: "fp-1", name: "disk" }),
    );
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({ name: "keep_get_alert", arguments: { fingerprint: "fp-1" } }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({
        alert: { fingerprint: "fp-1", name: "disk" },
      });
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe("https://keep.test/alerts/fp-1");
      expect(calls[0]?.apiKey).toBe(KEY);
    } finally {
      await close();
    }
  });

  it("lists incidents with limit, offset, sorting, and status filters", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({ limit: 25, offset: 0, count: 0, items: [] }),
    );
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_list_incidents",
          arguments: {
            limit: 25,
            offset: 0,
            sorting: "-last_seen_time",
            status: ["firing", "acknowledged"],
            cel: "severity == 'critical'",
          },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toContain("https://keep.test/incidents?");
      expect(calls[0]?.url).toContain("limit=25");
      expect(calls[0]?.url).toContain("offset=0");
      expect(calls[0]?.url).toContain("sorting=-last_seen_time");
      expect(calls[0]?.url).toContain("status=firing");
      expect(calls[0]?.url).toContain("status=acknowledged");
      expect(calls[0]?.url).toContain("cel=severity+%3D%3D+%27critical%27");
      expect(calls[0]?.apiKey).toBe(KEY);
      expect(parseObject(result.text)).toEqual({ limit: 25, offset: 0, count: 0, items: [] });
    } finally {
      await close();
    }
  });

  it("gets an incident and optionally its alerts", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.url.endsWith("/alerts?limit=25&offset=0")) {
        return Response.json({ limit: 25, offset: 0, count: 1, items: [{ fingerprint: "fp-1" }] });
      }
      return Response.json({ id: INCIDENT_ID, status: "firing" });
    });
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const withoutAlerts = readToolText(
        await client.callTool({
          name: "keep_get_incident",
          arguments: { incident_id: INCIDENT_ID },
        }),
      );
      expect(withoutAlerts.isError).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe(`https://keep.test/incidents/${INCIDENT_ID}`);
      const withAlerts = readToolText(
        await client.callTool({
          name: "keep_get_incident",
          arguments: { incident_id: INCIDENT_ID, include_alerts: true },
        }),
      );
      expect(withAlerts.isError).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toBe(
        `https://keep.test/incidents/${INCIDENT_ID}/alerts?limit=25&offset=0`,
      );
      expect(parseObject(withAlerts.text)).toEqual({
        incident: { id: INCIDENT_ID, status: "firing" },
        alerts: { limit: 25, offset: 0, count: 1, items: [{ fingerprint: "fp-1" }] },
      });
    } finally {
      await close();
    }
  });

  it("strips provider config and secret fields", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({
        providers: [{ type: "prometheus", config: { api_key: { required: true } } }],
        installed_providers: [
          {
            id: "p1",
            type: "slack",
            details: { authentication: { webhook_url: "https://hooks.example/secret" } },
            config: { token: "should-go" },
            display_name: "Slack",
          },
        ],
        linked_providers: [],
        is_localhost: false,
      }),
    );
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({ name: "keep_list_providers", arguments: {} }),
      );
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain("hooks.example");
      expect(result.text).not.toContain("should-go");
      expect(result.text).not.toContain("webhook_url");
      const body = parseObject(result.text);
      expect(body).toEqual({
        providers: [{ type: "prometheus" }],
        installed_providers: [{ id: "p1", type: "slack", display_name: "Slack" }],
        linked_providers: [],
        is_localhost: false,
      });
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe("https://keep.test/providers");
      expect(calls[0]?.apiKey).toBe(KEY);
    } finally {
      await close();
    }
  });

  it("lists workflows, topology services, and applications", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.url.endsWith("/workflows")) return Response.json([{ id: "wf-1", name: "Page" }]);
      if (captured.url.includes("/topology/applications")) {
        return Response.json([{ id: "app-1", name: "checkout" }]);
      }
      return Response.json([{ service: "api", display_name: "API" }]);
    });
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const workflows = readToolText(
        await client.callTool({ name: "keep_list_workflows", arguments: {} }),
      );
      const topology = readToolText(
        await client.callTool({
          name: "keep_get_topology",
          arguments: { environment: "prod", include_empty_deps: false },
        }),
      );
      const apps = readToolText(
        await client.callTool({ name: "keep_list_applications", arguments: {} }),
      );
      expect(workflows.isError).toBe(false);
      expect(topology.isError).toBe(false);
      expect(apps.isError).toBe(false);
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        "GET https://keep.test/workflows",
        "GET https://keep.test/topology?environment=prod&include_empty_deps=false",
        "GET https://keep.test/topology/applications",
      ]);
      expect(calls.every((call) => call.apiKey === KEY)).toBe(true);
    } finally {
      await close();
    }
  });
});

const WRITE_CASES = [
  {
    name: "keep_acknowledge_alert",
    args: { fingerprint: "fp-1" },
    method: "POST",
    path: "/alerts/enrich?dispose_on_new_alert=true",
    body: {
      fingerprint: "fp-1",
      enrichments: { status: "acknowledged", dismissed: "false", dismissUntil: "" },
    },
  },
  {
    name: "keep_resolve_alert",
    args: { fingerprint: "fp-1" },
    method: "POST",
    path: "/alerts/enrich?dispose_on_new_alert=true",
    body: {
      fingerprint: "fp-1",
      enrichments: { status: "resolved", dismissed: "false", dismissUntil: "" },
    },
  },
  {
    name: "keep_enrich_alert",
    args: { fingerprint: "fp-1", enrichments: { note: "checked", team: "sre" } },
    method: "POST",
    path: "/alerts/enrich?dispose_on_new_alert=false",
    body: { fingerprint: "fp-1", enrichments: { note: "checked", team: "sre" } },
  },
  {
    name: "keep_update_incident",
    args: {
      incident_id: INCIDENT_ID,
      change: { kind: "severity", severity: "high", comment: "raised" },
    },
    method: "POST",
    path: `/incidents/${INCIDENT_ID}/severity`,
    body: { severity: "high", comment: "raised" },
  },
  {
    name: "keep_update_incident",
    args: {
      incident_id: INCIDENT_ID,
      change: {
        kind: "status",
        status: "resolved",
        comment: "fixed",
        tagged_users: ["ada@example.com"],
      },
    },
    method: "POST",
    path: `/incidents/${INCIDENT_ID}/status`,
    body: { status: "resolved", comment: "fixed", tagged_users: ["ada@example.com"] },
  },
  {
    name: "keep_run_workflow",
    args: {
      workflow_id: "wf-1",
      type: "alert",
      body: { name: "manual-run", status: "firing", severity: "info", service: "api" },
      inputs: { env: "prod" },
    },
    method: "POST",
    path: "/workflows/wf-1/run",
    body: {
      type: "alert",
      body: { name: "manual-run", status: "firing", severity: "info", service: "api" },
      inputs: { env: "prod" },
    },
  },
] as const;

describe("write confirm gate", () => {
  it("rejects confirm values other than the boolean true at Zod", () => {
    expect(confirmField.safeParse(false).success).toBe(false);
    expect(confirmField.safeParse("true").success).toBe(false);
    expect(confirmField.safeParse(true).success).toBe(true);
    expect(confirmField.safeParse(undefined).success).toBe(true);
    expect(acknowledgeAlertInput.safeParse({ fingerprint: "fp-1", confirm: false }).success).toBe(
      false,
    );
    expect(resolveAlertInput.safeParse({ fingerprint: "fp-1", confirm: "true" }).success).toBe(
      false,
    );
    expect(
      enrichAlertInput.safeParse({
        fingerprint: "fp-1",
        enrichments: { note: "x" },
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      updateIncidentInput.safeParse({
        incident_id: INCIDENT_ID,
        change: { kind: "status", status: "resolved" },
        confirm: "true",
      }).success,
    ).toBe(false);
    expect(
      runWorkflowInput.safeParse({
        workflow_id: "wf-1",
        type: "alert",
        body: { name: "manual-run", status: "firing", severity: "info", service: "api" },
      }).success,
    ).toBe(true);
    expect(
      runWorkflowInput.safeParse({
        workflow_id: "wf-1",
        type: "alert",
        body: { severity: "catastrophic" },
      }).success,
    ).toBe(false);
    expect(
      runWorkflowInput.safeParse({
        workflow_id: "wf-1",
        type: "alert",
        body: { status: "merged" },
      }).success,
    ).toBe(false);
    expect(
      runWorkflowInput.safeParse({
        workflow_id: "wf-1",
        type: "incident",
        body: { status: "merged", severity: "high" },
      }).success,
    ).toBe(true);
    expect(runWorkflowInput.safeParse({ workflow_id: "wf-1", confirm: false }).success).toBe(false);
  });

  for (const testCase of WRITE_CASES) {
    const label = `${testCase.name} ${testCase.method} ${testCase.path}`;

    it(`${label}: omit confirm previews and does not fetch`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ status: "ok" }));
      const runtime = runtimeFor(fetchImpl);
      const { client, close } = await connectServer(runtime);
      try {
        const result = readToolText(
          await client.callTool({ name: testCase.name, arguments: { ...testCase.args } }),
        );
        expect(result.isError).toBe(false);
        expect(calls).toHaveLength(0);
        const body = parseObject(result.text);
        expect(body["dryRun"]).toBe(true);
        expect(body["method"]).toBe(testCase.method);
        expect(String(body["path"])).toContain(testCase.path.replace(/^\//, "").split("?")[0]);
        expect(body["body"]).toEqual(testCase.body);
        expect(result.text).not.toContain(KEY);
      } finally {
        await close();
      }
    });

    it(`${label}: confirm true sends one authenticated call`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ status: "ok" }));
      const runtime = runtimeFor(fetchImpl);
      const { client, close } = await connectServer(runtime);
      try {
        const result = readToolText(
          await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.args, confirm: true },
          }),
        );
        expect(result.isError).toBe(false);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe(testCase.method);
        expect(calls[0]?.url).toBe(`https://keep.test${testCase.path}`);
        expect(calls[0]?.apiKey).toBe(KEY);
        expect(calls[0]?.body).toEqual(testCase.body);
        expect(parseObject(result.text)).toEqual({ status: "ok" });
        expect(result.text).not.toContain(KEY);
      } finally {
        await close();
      }
    });

    it(`${label}: confirm false is an input error with zero calls`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ status: "ok" }));
      const runtime = runtimeFor(fetchImpl);
      const { client, close } = await connectServer(runtime);
      try {
        const result = readToolText(
          await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.args, confirm: false },
          }),
        );
        expect(result.isError).toBe(true);
        expect(result.text.toLowerCase()).toMatch(/input|confirm|validation/);
        expect(calls).toHaveLength(0);
      } finally {
        await close();
      }
    });

    it(`${label}: confirm string true is an input error with zero calls`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ status: "ok" }));
      const runtime = runtimeFor(fetchImpl);
      const { client, close } = await connectServer(runtime);
      try {
        const result = readToolText(
          await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.args, confirm: "true" },
          }),
        );
        expect(result.isError).toBe(true);
        expect(result.text.toLowerCase()).toMatch(/input|confirm|validation/);
        expect(calls).toHaveLength(0);
      } finally {
        await close();
      }
    });
  }
});

describe("incident field update", () => {
  const pastId = "11111111-1111-4111-8111-111111111111";
  const currentIncident = {
    id: INCIDENT_ID,
    user_generated_name: "Checkout down",
    assignee: null,
    user_summary: "disk filled overnight",
    same_incident_in_the_past_id: pastId,
    severity: "critical",
    status: "firing",
  };

  function fieldFetch() {
    return jsonFetch((captured) => {
      if (captured.method === "GET") return Response.json(currentIncident);
      return Response.json({ id: INCIDENT_ID, status: "firing" });
    });
  }

  it("previews an assignee change without calling Keep", async () => {
    const { fetchImpl, calls } = fieldFetch();
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_update_incident",
          arguments: {
            incident_id: INCIDENT_ID,
            change: { kind: "fields", assignee: "ada@example.com" },
          },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(0);
      const body = parseObject(result.text);
      expect(body["dryRun"]).toBe(true);
      expect(body["method"]).toBe("PUT");
      expect(body["body"]).toEqual({ assignee: "ada@example.com" });
      expect(String(body["summary"])).toContain("user_summary");
      expect(String(body["summary"])).toContain("same_incident_in_the_past_id");
      expect(String(body["summary"]).toLowerCase()).toContain("preserved");
      expect(String(body["summary"]).toLowerCase()).toContain("reading the current incident");
    } finally {
      await close();
    }
  });

  it("reads the incident and PUTs the merged fields", async () => {
    const { fetchImpl, calls } = fieldFetch();
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_update_incident",
          arguments: {
            incident_id: INCIDENT_ID,
            change: { kind: "fields", assignee: "ada@example.com" },
            confirm: true,
          },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe(`https://keep.test/incidents/${INCIDENT_ID}`);
      expect(calls[1]?.method).toBe("PUT");
      expect(calls[1]?.url).toBe(`https://keep.test/incidents/${INCIDENT_ID}`);
      expect(calls[1]?.body).toEqual({
        user_generated_name: "Checkout down",
        assignee: "ada@example.com",
        user_summary: "disk filled overnight",
        same_incident_in_the_past_id: pastId,
      });
      expect(calls[1]?.apiKey).toBe(KEY);
      expect(result.text).not.toContain(KEY);
    } finally {
      await close();
    }
  });

  it("clears same_incident_in_the_past_id and keeps the stored summary", async () => {
    const { fetchImpl, calls } = fieldFetch();
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_update_incident",
          arguments: {
            incident_id: INCIDENT_ID,
            change: { kind: "fields", same_incident_in_the_past_id: null },
            confirm: true,
          },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls[1]?.body).toEqual({
        user_generated_name: "Checkout down",
        assignee: null,
        user_summary: "disk filled overnight",
        same_incident_in_the_past_id: null,
      });
    } finally {
      await close();
    }
  });

  it("rejects confirm false and an empty fields change with zero calls", async () => {
    const { fetchImpl, calls } = fieldFetch();
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const rejected = readToolText(
        await client.callTool({
          name: "keep_update_incident",
          arguments: {
            incident_id: INCIDENT_ID,
            change: { kind: "fields", assignee: "ada@example.com" },
            confirm: false,
          },
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.text.toLowerCase()).toMatch(/input|confirm|validation/);
      const empty = readToolText(
        await client.callTool({
          name: "keep_update_incident",
          arguments: { incident_id: INCIDENT_ID, change: { kind: "fields" } },
        }),
      );
      expect(empty.isError).toBe(true);
      expect(empty.text.toLowerCase()).toMatch(/input/);
      expect(calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("does not PUT a preserved summary that contains the API key", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.method === "GET") {
        return Response.json({ ...currentIncident, user_summary: `see ${KEY}` });
      }
      return Response.json({ id: INCIDENT_ID });
    });
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_update_incident",
          arguments: {
            incident_id: INCIDENT_ID,
            change: { kind: "fields", assignee: "ada@example.com" },
            confirm: true,
          },
        }),
      );
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
      expect(JSON.stringify(calls)).not.toContain("[redacted]");
      expect(result.text).not.toContain(KEY);
    } finally {
      await close();
    }
  });
});

describe("write error redaction", () => {
  it("redacts an api key that Keep echoed in an error body", async () => {
    const { fetchImpl, calls } = jsonFetch(() => new Response(`denied ${KEY}`, { status: 401 }));
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "keep_acknowledge_alert",
          arguments: { fingerprint: "fp-1", confirm: true },
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain(KEY);
      expect(result.text).toContain("[redacted]");
      expect(calls).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

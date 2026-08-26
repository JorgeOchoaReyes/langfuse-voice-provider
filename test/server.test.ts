import test from "node:test";
import assert from "node:assert/strict";
import { SyncServer } from "../src/server/server.js";
import { SyncEngine } from "../src/sync/engine.js";
import { MemoryStateStore } from "../src/sync/state.js";
import { MockApi, seedVapi } from "./helpers/mock-api.js";
import { buildConfig } from "./helpers/build-config.js";

async function withServer(
  options: { webhookSecret?: string } = {},
  run: (base: string, api: MockApi) => Promise<void>,
): Promise<void> {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "A prompt." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const engine = new SyncEngine({
    config,
    fetchImpl: api.fetch,
    stateStore: new MemoryStateStore(),
  });
  const server = new SyncServer({
    engine,
    host: "127.0.0.1",
    port: 0,
    ...(options.webhookSecret ? { webhookSecret: options.webhookSecret } : {}),
  });
  await server.listen();
  try {
    await run(`http://127.0.0.1:${server.address()?.port}`, api);
  } finally {
    await server.close();
  }
}

test("health endpoints are open", async () => {
  await withServer({}, async (base) => {
    for (const path of ["/healthz", "/readyz"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    }
  });
});

test("metrics are exposed in Prometheus text format", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    const body = await response.text();
    assert.match(body, /langfuse_voice_runs_total 0/);
    assert.match(body, /# TYPE langfuse_voice_runs_total counter/);
  });
});

test("sync is rejected when no secret is configured", async () => {
  await withServer({}, async (base, api) => {
    const response = await fetch(`${base}/sync`, { method: "POST" });
    assert.equal(response.status, 401);
    assert.equal(api.requests.length, 0);
  });
});

test("a wrong secret is rejected and triggers nothing", async () => {
  await withServer({ webhookSecret: "correct-horse" }, async (base, api) => {
    const response = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(response.status, 401);
    assert.equal(api.requests.length, 0);
  });
});

test("the right secret runs a sync and returns the report", async () => {
  await withServer({ webhookSecret: "correct-horse" }, async (base) => {
    const response = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { authorization: "Bearer correct-horse" },
    });
    assert.equal(response.status, 200);
    const report = (await response.json()) as { counts: Record<string, number> };
    assert.equal(report.counts["created-prompt"], 1);
  });
});

test("the secret is also accepted via header and query string", async () => {
  await withServer({ webhookSecret: "s3cret" }, async (base) => {
    const viaHeader = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { "x-webhook-secret": "s3cret" },
    });
    assert.equal(viaHeader.status, 200);

    const viaQuery = await fetch(`${base}/sync?secret=s3cret`, { method: "POST" });
    assert.equal(viaQuery.status, 200);
  });
});

test("a webhook body narrows the run to the prompt that changed", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "One." });
  seedVapi(api, { assistantId: "asst_2", prompt: "Two." });
  const config = buildConfig([
    { id: "one", provider: "vapi", agentId: "asst_1", prompt: "voice/one" },
    { id: "two", provider: "vapi", agentId: "asst_2", prompt: "voice/two" },
  ]);
  const engine = new SyncEngine({
    config,
    fetchImpl: api.fetch,
    stateStore: new MemoryStateStore(),
  });
  const server = new SyncServer({
    engine,
    host: "127.0.0.1",
    port: 0,
    webhookSecret: "s",
  });
  await server.listen();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address()?.port}/webhooks/langfuse`,
      {
        method: "POST",
        headers: { authorization: "Bearer s", "content-type": "application/json" },
        body: JSON.stringify({ promptName: "voice/two" }),
      },
    );
    const report = (await response.json()) as { results: Array<{ bindingId: string }> };
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]?.bindingId, "two");
  } finally {
    await server.close();
  }
});

test("a garbage webhook body still triggers a full run rather than failing", async () => {
  await withServer({ webhookSecret: "s" }, async (base) => {
    const response = await fetch(`${base}/webhooks/langfuse`, {
      method: "POST",
      headers: { authorization: "Bearer s", "content-type": "application/json" },
      body: "not json at all",
    });
    assert.equal(response.status, 200);
  });
});

test("a run that ends with a conflict answers 409", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Provider." });
  api.prompts.set("voice/outbound", [
    {
      name: "voice/outbound",
      version: 1,
      type: "text",
      prompt: "Langfuse.",
      labels: ["production"],
      tags: [],
      commitMessage: null,
      config: {},
    },
  ]);
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const engine = new SyncEngine({
    config,
    fetchImpl: api.fetch,
    stateStore: new MemoryStateStore(),
  });
  const server = new SyncServer({ engine, host: "127.0.0.1", port: 0, webhookSecret: "s" });
  await server.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address()?.port}/sync`, {
      method: "POST",
      headers: { authorization: "Bearer s" },
    });
    assert.equal(response.status, 409);
  } finally {
    await server.close();
  }
});

test("concurrent triggers are coalesced into one run", async () => {
  // A run slow enough that the other four requests are guaranteed to arrive
  // while it is still in flight — otherwise the test would pass by accident.
  let runs = 0;
  const engine = {
    run: async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.100Z",
        durationMs: 100,
        dryRun: false,
        results: [],
        counts: {
          "in-sync": 0,
          pushed: 0,
          pulled: 0,
          "created-prompt": 0,
          conflict: 0,
          skipped: 0,
          error: 0,
        },
        ok: true,
      };
    },
  } as unknown as SyncEngine;

  const server = new SyncServer({
    engine,
    host: "127.0.0.1",
    port: 0,
    webhookSecret: "s",
  });
  await server.listen();
  try {
    const base = `http://127.0.0.1:${server.address()?.port}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${base}/sync`, {
          method: "POST",
          headers: { authorization: "Bearer s" },
        }),
      ),
    );
    for (const response of responses) assert.equal(response.status, 200);
    assert.equal(runs, 1);
  } finally {
    await server.close();
  }
});

test("a trigger after the previous run finished starts a fresh run", async () => {
  await withServer({ webhookSecret: "s" }, async (base, api) => {
    const headers = { authorization: "Bearer s" };
    await fetch(`${base}/sync`, { method: "POST", headers });
    await fetch(`${base}/sync`, { method: "POST", headers });
    assert.equal(api.requestsFor("/assistant/asst_1").length, 2);
  });
});

test("status reflects the last run", async () => {
  await withServer({ webhookSecret: "s" }, async (base) => {
    await fetch(`${base}/sync`, { method: "POST", headers: { authorization: "Bearer s" } });
    const response = await fetch(`${base}/status`);
    const status = (await response.json()) as {
      runsTotal: number;
      lastReport: { counts: Record<string, number> } | null;
    };
    assert.equal(status.runsTotal, 1);
    assert.equal(status.lastReport?.counts["created-prompt"], 1);
  });
});

test("unknown routes are 404", async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

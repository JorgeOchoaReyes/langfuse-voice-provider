import test from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../src/sync/engine.js";
import { MemoryStateStore } from "../src/sync/state.js";
import { CONFIG_NAMESPACE } from "../src/langfuse/client.js";
import {
  MockApi,
  seedElevenLabs,
  seedLangfusePrompt,
  seedRetell,
  seedVapi,
} from "./helpers/mock-api.js";
import { buildConfig } from "./helpers/build-config.js";
import type { AppConfig } from "../src/config/load.js";

function makeEngine(config: AppConfig, api: MockApi, stateStore = new MemoryStateStore()) {
  return {
    engine: new SyncEngine({ config, fetchImpl: api.fetch, stateStore }),
    stateStore,
  };
}

test("a prompt missing from Langfuse is seeded from the live agent", async () => {
  const api = new MockApi();
  seedRetell(api, {
    agentId: "agent_1",
    llmId: "llm_1",
    generalPrompt: "You are a support agent.",
    beginMessage: "Hi!",
  });
  const config = buildConfig([
    { provider: "retell", agentId: "agent_1", prompt: "voice/support", tags: ["voice"] },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts["created-prompt"], 1);
  const created = api.latestPrompt("voice/support");
  assert.equal(created?.prompt, "You are a support agent.");
  assert.equal(created?.version, 1);
  assert.deepEqual(created?.labels, ["production"]);
  assert.deepEqual(created?.tags, ["voice"]);
  // The extra field round-trips through the prompt config.
  const voice = created?.config[CONFIG_NAMESPACE] as { fields: Record<string, string> };
  assert.equal(voice.fields["beginMessage"], "Hi!");
});

test("seeding records where the prompt came from", async () => {
  const api = new MockApi();
  seedRetell(api, { agentId: "agent_1", llmId: "llm_9", generalPrompt: "Hello." });
  const config = buildConfig([
    { provider: "retell", agentId: "agent_1", prompt: "voice/support" },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();

  const voice = api.latestPrompt("voice/support")?.config[CONFIG_NAMESPACE] as {
    provider: string;
    agentId: string;
    origin: Record<string, string>;
    syncedFrom: string;
  };
  assert.equal(voice.provider, "retell");
  assert.equal(voice.agentId, "agent_1");
  assert.equal(voice.origin["llmId"], "llm_9");
  assert.equal(voice.syncedFrom, "provider");
});

test("matching sides are reported in-sync and nothing is written", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Same prompt." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Same prompt." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts["in-sync"], 1);
  assert.equal(api.prompts.get("voice/outbound")?.length, 1);
  assert.equal(api.requests.filter((r) => r.method === "PATCH").length, 0);
});

test("whitespace-only differences do not create a version", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Be brief.  \r\n" });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Be brief." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts["in-sync"], 1);
});

test("langfuse-to-provider pushes the Langfuse prompt onto the agent", async () => {
  const api = new MockApi();
  seedElevenLabs(api, { agentId: "agent_el", prompt: "Stale prompt." });
  seedLangfusePrompt(api, { name: "voice/onboarding", text: "Fresh prompt." });
  const config = buildConfig([
    {
      provider: "elevenlabs",
      agentId: "agent_el",
      prompt: "voice/onboarding",
      direction: "langfuse-to-provider",
    },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.pushed, 1);
  const agent = api.elevenLabsAgents.get("agent_el") as Record<string, any>;
  assert.equal(agent["conversation_config"].agent.prompt.prompt, "Fresh prompt.");
  // A push must not add a Langfuse version — Langfuse was already the source.
  assert.equal(api.prompts.get("voice/onboarding")?.length, 1);
});

test("provider-to-langfuse appends a new labelled version", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Edited in the Vapi dashboard." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Original." });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      direction: "provider-to-langfuse",
    },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.pulled, 1);
  const versions = api.prompts.get("voice/outbound") ?? [];
  assert.equal(versions.length, 2);
  assert.equal(versions[1]?.prompt, "Edited in the Vapi dashboard.");
  assert.deepEqual(versions[1]?.labels, ["production"]);
  // The label moves off the old version, exactly as Langfuse does.
  assert.deepEqual(versions[0]?.labels, []);
  assert.match(versions[1]?.commitMessage ?? "", /Synced from vapi agent asst_1/);
});

test("a pulled version keeps unrelated application config on the prompt", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "New." });
  seedLangfusePrompt(api, {
    name: "voice/outbound",
    text: "Old.",
    config: { temperature: 0.4, myApp: { flag: true } },
  });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      direction: "provider-to-langfuse",
    },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();

  const latest = api.latestPrompt("voice/outbound");
  assert.equal(latest?.config["temperature"], 0.4);
  assert.deepEqual(latest?.config["myApp"], { flag: true });
  assert.ok(latest?.config[CONFIG_NAMESPACE]);
});

test("bidirectional uses recorded state to push when only Langfuse moved", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Shared." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Shared." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const store = new MemoryStateStore();
  const { engine } = makeEngine(config, api, store);

  // First run converges and records the baseline.
  await engine.run();
  // Now Langfuse alone moves.
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Changed in Langfuse." });

  const report = await engine.run();

  assert.equal(report.counts.pushed, 1);
  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "Changed in Langfuse.");
});

test("bidirectional uses recorded state to pull when only the provider moved", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Shared." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Shared." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();
  // Someone edits the prompt in the Vapi dashboard.
  seedVapi(api, { assistantId: "asst_1", prompt: "Changed in the dashboard." });

  const report = await engine.run();

  assert.equal(report.counts.pulled, 1);
  assert.equal(api.latestPrompt("voice/outbound")?.prompt, "Changed in the dashboard.");
});

test("bidirectional reports a conflict when both sides moved", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Shared." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Shared." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();
  seedVapi(api, { assistantId: "asst_1", prompt: "Provider edit." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Langfuse edit." });

  const report = await engine.run();

  assert.equal(report.counts.conflict, 1);
  assert.equal(report.ok, false);
  // Neither side is touched while the conflict stands.
  assert.equal(api.latestPrompt("voice/outbound")?.prompt, "Langfuse edit.");
  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "Provider edit.");
});

test("conflictPolicy prefer-langfuse resolves a both-sides-changed conflict by pushing", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Shared." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Shared." });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      conflictPolicy: "prefer-langfuse",
    },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();
  seedVapi(api, { assistantId: "asst_1", prompt: "Provider edit." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Langfuse edit." });

  const report = await engine.run();

  assert.equal(report.counts.pushed, 1);
  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "Langfuse edit.");
});

test("conflictPolicy prefer-provider resolves the same conflict by pulling", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Shared." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Shared." });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      conflictPolicy: "prefer-provider",
    },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();
  seedVapi(api, { assistantId: "asst_1", prompt: "Provider edit." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Langfuse edit." });

  const report = await engine.run();

  assert.equal(report.counts.pulled, 1);
  assert.equal(api.latestPrompt("voice/outbound")?.prompt, "Provider edit.");
});

test("without recorded state a divergence falls back to the conflict policy", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Provider." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Langfuse." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.conflict, 1);
});

test("dry run reports the plan and writes nothing", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Provider." });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Langfuse." });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      direction: "langfuse-to-provider",
    },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run({ dryRun: true });

  assert.equal(report.counts.pushed, 1);
  assert.equal(report.results[0]?.planned, true);
  assert.equal(api.requests.filter((r) => r.method === "PATCH").length, 0);
  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "Provider.");
});

test("one failing binding does not stop the others", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_ok", prompt: "Fine." });
  seedElevenLabs(api, { agentId: "agent_bad", prompt: "Also fine." });
  const config = buildConfig([
    { provider: "elevenlabs", agentId: "agent_bad", prompt: "voice/bad" },
    { provider: "vapi", agentId: "asst_ok", prompt: "voice/ok" },
  ]);
  const { engine } = makeEngine(config, api);
  // Fail every attempt at the ElevenLabs read.
  const originalFetch = api.fetch;
  const failing = (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/v1/convai/agents/agent_bad")) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 400 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const engine2 = new SyncEngine({
    config,
    fetchImpl: failing,
    stateStore: new MemoryStateStore(),
  });

  const report = await engine2.run();

  assert.equal(report.counts.error, 1);
  assert.equal(report.counts["created-prompt"], 1);
  assert.equal(api.latestPrompt("voice/ok")?.prompt, "Fine.");
  assert.equal(report.ok, false);
});

test("an unsyncable agent is skipped with an explanation, not an error", async () => {
  const api = new MockApi();
  api.retellAgents.set("agent_flow", {
    agent_id: "agent_flow",
    response_engine: { type: "conversation-flow", conversation_flow_id: "flow_1" },
  });
  const config = buildConfig([
    { provider: "retell", agentId: "agent_flow", prompt: "voice/flow" },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.skipped, 1);
  assert.equal(report.counts.error, 0);
  assert.equal(report.ok, true);
  assert.match(report.results[0]?.summary ?? "", /conversation-flow/);
});

test("a disabled binding is skipped without contacting any API", async () => {
  const api = new MockApi();
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/x", enabled: false },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.skipped, 1);
  assert.equal(api.requests.length, 0);
});

test("--only narrows a run by binding id, prompt name or agent id", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "One." });
  seedVapi(api, { assistantId: "asst_2", prompt: "Two." });
  const config = buildConfig([
    { id: "first", provider: "vapi", agentId: "asst_1", prompt: "voice/one" },
    { id: "second", provider: "vapi", agentId: "asst_2", prompt: "voice/two" },
  ]);
  const { engine } = makeEngine(config, api);

  const byId = await engine.run({ only: ["first"] });
  assert.equal(byId.results.length, 1);
  assert.equal(byId.results[0]?.bindingId, "first");

  const byPrompt = await engine.run({ only: ["voice/two"] });
  assert.equal(byPrompt.results.length, 1);
  assert.equal(byPrompt.results[0]?.bindingId, "second");

  const byAgent = await engine.run({ only: ["asst_1"] });
  assert.equal(byAgent.results[0]?.bindingId, "first");
});

test("syncFields false leaves provider-side extras untouched", async () => {
  const api = new MockApi();
  seedVapi(api, {
    assistantId: "asst_1",
    prompt: "Old.",
    firstMessage: "Provider greeting.",
  });
  seedLangfusePrompt(api, {
    name: "voice/outbound",
    text: "New.",
    fields: { firstMessage: "Langfuse greeting." },
  });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      direction: "langfuse-to-provider",
      syncFields: false,
    },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();

  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "New.");
  assert.equal(assistant["firstMessage"], "Provider greeting.");
});

test("bindings with variables push the rendered prompt and stay in sync after", async () => {
  const api = new MockApi();
  seedElevenLabs(api, { agentId: "agent_el", prompt: "old" });
  seedLangfusePrompt(api, {
    name: "voice/onboarding",
    text: "You work for {{company}}. Ask for {{caller_name}}.",
  });
  const config = buildConfig([
    {
      provider: "elevenlabs",
      agentId: "agent_el",
      prompt: "voice/onboarding",
      direction: "langfuse-to-provider",
      variables: { company: "Acme" },
    },
  ]);
  const { engine } = makeEngine(config, api);

  const first = await engine.run();
  assert.equal(first.counts.pushed, 1);
  const agent = api.elevenLabsAgents.get("agent_el") as Record<string, any>;
  // `company` is substituted; `caller_name` is left for the provider at call time.
  assert.equal(
    agent["conversation_config"].agent.prompt.prompt,
    "You work for Acme. Ask for {{caller_name}}.",
  );

  // A second pass must recognise the rendered agent as already in sync.
  const second = await engine.run();
  assert.equal(second.counts["in-sync"], 1);
});

test("a chat prompt in Langfuse is folded down to its system turns", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "stale" });
  api.prompts.set("voice/chat", [
    {
      name: "voice/chat",
      version: 1,
      type: "chat",
      prompt: [
        { role: "system", content: "Line one." },
        { role: "user", content: "Ignored." },
        { role: "system", content: "Line two." },
      ],
      labels: ["production"],
      tags: [],
      commitMessage: null,
      config: {},
    },
  ]);
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/chat",
      direction: "langfuse-to-provider",
    },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();

  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "Line one.\n\nLine two.");
});

test("all three providers sync in a single run", async () => {
  const api = new MockApi();
  seedRetell(api, { agentId: "agent_r", llmId: "llm_r", generalPrompt: "Retell prompt." });
  seedElevenLabs(api, { agentId: "agent_e", prompt: "ElevenLabs prompt." });
  seedVapi(api, { assistantId: "asst_v", prompt: "Vapi prompt." });
  const config = buildConfig([
    { provider: "retell", agentId: "agent_r", prompt: "voice/retell" },
    { provider: "elevenlabs", agentId: "agent_e", prompt: "voice/elevenlabs" },
    { provider: "vapi", agentId: "asst_v", prompt: "voice/vapi" },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts["created-prompt"], 3);
  assert.equal(report.ok, true);
  assert.equal(api.latestPrompt("voice/retell")?.prompt, "Retell prompt.");
  assert.equal(api.latestPrompt("voice/elevenlabs")?.prompt, "ElevenLabs prompt.");
  assert.equal(api.latestPrompt("voice/vapi")?.prompt, "Vapi prompt.");
});

test("a non-production label is read and written throughout", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Staging edit." });
  seedLangfusePrompt(api, {
    name: "voice/outbound",
    text: "Old staging.",
    label: "staging",
  });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      label: "staging",
      direction: "provider-to-langfuse",
    },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.pulled, 1);
  assert.deepEqual(api.latestPrompt("voice/outbound")?.labels, ["staging"]);
});

test("a hand-authored Langfuse prompt does not clobber the agent's greeting", async () => {
  const api = new MockApi();
  seedVapi(api, {
    assistantId: "asst_1",
    prompt: "Old text.",
    firstMessage: "Provider greeting.",
  });
  // Authored in the Langfuse UI: no field bookkeeping at all.
  seedLangfusePrompt(api, { name: "voice/outbound", text: "New text." });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      direction: "langfuse-to-provider",
    },
  ]);
  const { engine } = makeEngine(config, api);

  const report = await engine.run();

  assert.equal(report.counts.pushed, 1);
  const assistant = api.vapiAssistants.get("asst_1") as Record<string, any>;
  assert.equal(assistant["model"].messages[0].content, "New text.");
  assert.equal(assistant["firstMessage"], "Provider greeting.");
  // The report must not claim a change that was never made.
  assert.deepEqual(
    report.results[0]?.changes.map((change) => change.field),
    ["text"],
  );
});

test("an unmanaged field does not make a binding drift forever", async () => {
  const api = new MockApi();
  seedVapi(api, {
    assistantId: "asst_1",
    prompt: "Old text.",
    firstMessage: "Provider greeting.",
  });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "New text." });
  const config = buildConfig([
    { provider: "vapi", agentId: "asst_1", prompt: "voice/outbound" },
    // Bidirectional, so a spurious diff would show up as a conflict.
  ]);
  const store = new MemoryStateStore();
  const { engine } = makeEngine(config, api, store);

  // Seed the baseline so the first divergence resolves as a Langfuse-side edit.
  await store.set("vapi:asst_1", {
    langfuseHash: "stale",
    providerHash: (await import("../src/core/hash.js")).hashDocument({
      text: "Old text.",
      fields: {},
    }),
    langfuseVersion: 1,
    lastSyncAt: "2026-01-01T00:00:00.000Z",
    lastDirection: "none",
  });

  const first = await engine.run();
  assert.equal(first.counts.pushed, 1);

  // The very next pass must settle, not re-push or report a conflict.
  const second = await engine.run();
  assert.equal(second.counts["in-sync"], 1, "expected the binding to converge");
});

test("a pull captures fields that were not managed before", async () => {
  const api = new MockApi();
  seedVapi(api, {
    assistantId: "asst_1",
    prompt: "Changed on the provider.",
    firstMessage: "Provider greeting.",
  });
  seedLangfusePrompt(api, { name: "voice/outbound", text: "Original." });
  const config = buildConfig([
    {
      provider: "vapi",
      agentId: "asst_1",
      prompt: "voice/outbound",
      direction: "provider-to-langfuse",
    },
  ]);
  const { engine } = makeEngine(config, api);

  await engine.run();

  const voice = api.latestPrompt("voice/outbound")?.config[CONFIG_NAMESPACE] as {
    fields: Record<string, string>;
  };
  assert.equal(voice.fields["firstMessage"], "Provider greeting.");

  // Now that it is recorded, it is managed: a later push governs it.
  const second = await engine.run();
  assert.equal(second.counts["in-sync"], 1);
});

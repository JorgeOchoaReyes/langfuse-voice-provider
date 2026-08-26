import test from "node:test";
import assert from "node:assert/strict";
import { RetellProvider } from "../src/providers/retell.js";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.js";
import { VapiProvider } from "../src/providers/vapi.js";
import { UnsupportedAgentError } from "../src/core/errors.js";
import { MockApi, seedElevenLabs, seedRetell, seedVapi } from "./helpers/mock-api.js";

// --- Retell ---------------------------------------------------------------

test("retell reads the prompt from the LLM behind the agent", async () => {
  const api = new MockApi();
  seedRetell(api, {
    agentId: "agent_1",
    llmId: "llm_1",
    generalPrompt: "You are a support agent.",
    beginMessage: "Hi, how can I help?",
  });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  const result = await provider.getPrompt({ agentId: "agent_1" });

  assert.equal(result.document.text, "You are a support agent.");
  assert.equal(result.document.fields["beginMessage"], "Hi, how can I help?");
  assert.equal(result.origin["llmId"], "llm_1");
});

test("retell flattens per-state prompts into namespaced fields", async () => {
  const api = new MockApi();
  seedRetell(api, {
    agentId: "agent_1",
    llmId: "llm_1",
    generalPrompt: "Root.",
    states: [
      { name: "greeting", state_prompt: "Say hello." },
      { name: "booking", state_prompt: "Take the booking." },
    ],
  });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  const result = await provider.getPrompt({ agentId: "agent_1" });

  assert.equal(result.document.fields["state:greeting"], "Say hello.");
  assert.equal(result.document.fields["state:booking"], "Take the booking.");
});

test("retell writes to update-retell-llm, not to the agent", async () => {
  const api = new MockApi();
  seedRetell(api, { agentId: "agent_1", llmId: "llm_1", generalPrompt: "Old." });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.setPrompt(
    { agentId: "agent_1" },
    { text: "New.", fields: { beginMessage: "Hello." } },
  );

  const patch = api.requestsFor("/update-retell-llm").at(-1);
  assert.ok(patch, "expected a PATCH to /update-retell-llm");
  assert.equal(patch.method, "PATCH");
  assert.deepEqual(patch.body, { general_prompt: "New.", begin_message: "Hello." });
  assert.equal(api.requestsFor("/update-agent").length, 0);
});

test("retell preserves states it was not asked to change", async () => {
  const api = new MockApi();
  seedRetell(api, {
    agentId: "agent_1",
    llmId: "llm_1",
    generalPrompt: "Root.",
    states: [
      { name: "greeting", state_prompt: "Say hello." },
      { name: "booking", state_prompt: "Take the booking." },
    ],
  });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.setPrompt(
    { agentId: "agent_1" },
    { text: "Root.", fields: { "state:greeting": "Greet warmly." } },
  );

  const llm = api.retellLlms.get("llm_1") as Record<string, unknown>;
  const states = llm["states"] as Array<{ name: string; state_prompt: string }>;
  assert.equal(states.length, 2);
  assert.equal(states[0]?.state_prompt, "Greet warmly.");
  assert.equal(states[1]?.state_prompt, "Take the booking.");
});

test("retell skips the agent lookup when llmId is supplied", async () => {
  const api = new MockApi();
  seedRetell(api, { agentId: "agent_1", llmId: "llm_1", generalPrompt: "Hi." });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.getPrompt({ agentId: "agent_1", options: { llmId: "llm_1" } });

  assert.equal(api.requestsFor("/get-agent").length, 0);
  assert.equal(api.requestsFor("/get-retell-llm").length, 1);
});

test("retell explains itself when the agent has no single prompt", async () => {
  const api = new MockApi();
  api.retellAgents.set("agent_flow", {
    agent_id: "agent_flow",
    agent_name: "Flow agent",
    response_engine: { type: "conversation-flow", conversation_flow_id: "flow_1" },
  });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  await assert.rejects(
    () => provider.getPrompt({ agentId: "agent_flow" }),
    (error: unknown) =>
      error instanceof UnsupportedAgentError &&
      /conversation-flow/.test(error.message),
  );
});

test("retell marks non-llm agents unsyncable when listing", async () => {
  const api = new MockApi();
  seedRetell(api, { agentId: "agent_1", llmId: "llm_1", generalPrompt: "Hi." });
  api.retellAgents.set("agent_2", {
    agent_id: "agent_2",
    agent_name: "Custom",
    response_engine: { type: "custom-llm" },
  });
  const provider = new RetellProvider({ apiKey: "key", fetchImpl: api.fetch });

  const agents = await provider.listAgents();

  assert.equal(agents.find((a) => a.id === "agent_1")?.syncable, true);
  const custom = agents.find((a) => a.id === "agent_2");
  assert.equal(custom?.syncable, false);
  assert.match(custom?.reason ?? "", /custom-llm/);
});

// --- ElevenLabs -----------------------------------------------------------

test("elevenlabs reads the deeply nested prompt", async () => {
  const api = new MockApi();
  seedElevenLabs(api, {
    agentId: "agent_el",
    prompt: "You are a friendly guide.",
    firstMessage: "Welcome!",
  });
  const provider = new ElevenLabsProvider({ apiKey: "key", fetchImpl: api.fetch });

  const result = await provider.getPrompt({ agentId: "agent_el" });

  assert.equal(result.document.text, "You are a friendly guide.");
  assert.equal(result.document.fields["firstMessage"], "Welcome!");
});

test("elevenlabs update preserves unrelated voice and ASR settings", async () => {
  const api = new MockApi();
  seedElevenLabs(api, { agentId: "agent_el", prompt: "Old prompt." });
  const provider = new ElevenLabsProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.setPrompt(
    { agentId: "agent_el" },
    { text: "New prompt.", fields: { firstMessage: "Hi!" } },
  );

  const patch = api.requestsFor("/v1/convai/agents/agent_el").at(-1);
  const body = patch?.body as {
    conversation_config: {
      tts?: { voice_id?: string };
      asr?: { quality?: string };
      agent: {
        prompt: { prompt: string; llm?: string; temperature?: number };
        first_message?: string;
        language?: string;
      };
    };
  };
  assert.equal(body.conversation_config.agent.prompt.prompt, "New prompt.");
  assert.equal(body.conversation_config.agent.first_message, "Hi!");
  // Everything we did not touch must survive the round trip.
  assert.equal(body.conversation_config.tts?.voice_id, "voice_123");
  assert.equal(body.conversation_config.asr?.quality, "high");
  assert.equal(body.conversation_config.agent.prompt.llm, "gpt-4o");
  assert.equal(body.conversation_config.agent.prompt.temperature, 0.2);
  assert.equal(body.conversation_config.agent.language, "en");
});

test("elevenlabs sends the xi-api-key header", async () => {
  const api = new MockApi();
  seedElevenLabs(api, { agentId: "agent_el", prompt: "Hi." });
  const provider = new ElevenLabsProvider({ apiKey: "secret-key", fetchImpl: api.fetch });

  await provider.getPrompt({ agentId: "agent_el" });

  assert.equal(api.requests.at(-1)?.headers["xi-api-key"], "secret-key");
});

// --- Vapi -----------------------------------------------------------------

test("vapi reads the first system message", async () => {
  const api = new MockApi();
  seedVapi(api, {
    assistantId: "asst_1",
    prompt: "Qualify the lead.",
    firstMessage: "Hey there.",
  });
  const provider = new VapiProvider({ apiKey: "key", fetchImpl: api.fetch });

  const result = await provider.getPrompt({ agentId: "asst_1" });

  assert.equal(result.document.text, "Qualify the lead.");
  assert.equal(result.document.fields["firstMessage"], "Hey there.");
});

test("vapi resends the whole model object so nothing is dropped on PATCH", async () => {
  const api = new MockApi();
  seedVapi(api, { assistantId: "asst_1", prompt: "Old." });
  const provider = new VapiProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.setPrompt(
    { agentId: "asst_1" },
    { text: "New.", fields: { firstMessage: "Hello." } },
  );

  const patch = api.requestsFor("/assistant/asst_1").at(-1);
  const body = patch?.body as {
    model: {
      provider: string;
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    firstMessage?: string;
  };
  assert.equal(body.model.provider, "openai");
  assert.equal(body.model.model, "gpt-4o");
  assert.equal(body.model.temperature, 0.3);
  assert.deepEqual(body.model.messages, [{ role: "system", content: "New." }]);
  assert.equal(body.firstMessage, "Hello.");
});

test("vapi inserts a system message when the assistant has none", async () => {
  const api = new MockApi();
  api.vapiAssistants.set("asst_2", {
    id: "asst_2",
    name: "No system prompt",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "assistant", content: "Hi" }],
    },
  });
  const provider = new VapiProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.setPrompt({ agentId: "asst_2" }, { text: "Be helpful.", fields: {} });

  const body = api.requestsFor("/assistant/asst_2").at(-1)?.body as {
    model: { messages: Array<{ role: string; content: string }> };
  };
  assert.deepEqual(body.model.messages, [
    { role: "system", content: "Be helpful." },
    { role: "assistant", content: "Hi" },
  ]);
});

test("vapi leaves non-system messages alone", async () => {
  const api = new MockApi();
  api.vapiAssistants.set("asst_3", {
    id: "asst_3",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Old system." },
        { role: "assistant", content: "Keep me." },
      ],
    },
  });
  const provider = new VapiProvider({ apiKey: "key", fetchImpl: api.fetch });

  await provider.setPrompt({ agentId: "asst_3" }, { text: "New system.", fields: {} });

  const body = api.requestsFor("/assistant/asst_3").at(-1)?.body as {
    model: { messages: Array<{ role: string; content: string }> };
  };
  assert.deepEqual(body.model.messages, [
    { role: "system", content: "New system." },
    { role: "assistant", content: "Keep me." },
  ]);
});

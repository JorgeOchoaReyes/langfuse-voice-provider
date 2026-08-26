import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  expandEnvPlaceholders,
  findConfigFile,
  loadConfig,
  parseConfig,
} from "../src/config/load.js";
import { ConfigError } from "../src/core/errors.js";

const ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-test",
  LANGFUSE_SECRET_KEY: "sk-test",
  VAPI_API_KEY: "vapi-key",
} satisfies NodeJS.ProcessEnv;

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "lfv-"));
  const file = path.join(dir, "langfuse-voice.config.yaml");
  await writeFile(file, contents, "utf8");
  return file;
}

test("schema applies defaults for an empty config", () => {
  const config = parseConfig({});
  assert.equal(config.defaults.direction, "bidirectional");
  assert.equal(config.defaults.conflictPolicy, "manual");
  assert.equal(config.defaults.label, "production");
  assert.equal(config.state.driver, "file");
  assert.equal(config.watch.intervalSeconds, 60);
});

test("unknown top-level keys are rejected rather than ignored", () => {
  assert.throws(() => parseConfig({ bindingz: [] }), ConfigError);
});

test("an invalid provider name is rejected with a readable path", () => {
  assert.throws(
    () => parseConfig({ bindings: [{ provider: "twilio", agentId: "a", prompt: "p" }] }),
    (error: unknown) =>
      error instanceof ConfigError && /bindings\.0\.provider/.test(error.message),
  );
});

test("env placeholders are expanded, with fallbacks", () => {
  const expanded = expandEnvPlaceholders(
    "a=${FOO} b=${MISSING:-fallback} c=${ALSO_MISSING}",
    { FOO: "bar" },
  );
  assert.equal(expanded, "a=bar b=fallback c=");
});

test("defaults flow into bindings and per-binding values override them", async () => {
  const file = await writeConfig(`
defaults:
  direction: langfuse-to-provider
  label: staging
  tags: [voice]
bindings:
  - provider: vapi
    agentId: asst_1
    prompt: voice/one
  - provider: vapi
    agentId: asst_2
    prompt: voice/two
    direction: bidirectional
    label: production
    tags: [outbound]
`);
  const config = await loadConfig({ configPath: file, env: ENV });

  assert.equal(config.bindings[0]?.direction, "langfuse-to-provider");
  assert.equal(config.bindings[0]?.label, "staging");
  assert.deepEqual(config.bindings[0]?.tags, ["voice"]);
  assert.equal(config.bindings[1]?.direction, "bidirectional");
  assert.equal(config.bindings[1]?.label, "production");
  assert.deepEqual(config.bindings[1]?.tags, ["voice", "outbound"]);
});

test("binding ids default to provider:agentId and must be unique", async () => {
  const file = await writeConfig(`
bindings:
  - provider: vapi
    agentId: asst_1
    prompt: voice/one
`);
  const config = await loadConfig({ configPath: file, env: ENV });
  assert.equal(config.bindings[0]?.id, "vapi:asst_1");

  const dupes = await writeConfig(`
bindings:
  - provider: vapi
    agentId: asst_1
    prompt: voice/one
  - provider: vapi
    agentId: asst_1
    prompt: voice/two
`);
  await assert.rejects(
    () => loadConfig({ configPath: dupes, env: ENV }),
    (error: unknown) =>
      error instanceof ConfigError && /Duplicate binding id/.test(error.message),
  );
});

test("env credentials win over the config file", async () => {
  const file = await writeConfig(`
langfuse:
  publicKey: from-file
  secretKey: from-file
providers:
  vapi:
    apiKey: from-file
`);
  const config = await loadConfig({
    configPath: file,
    env: { ...ENV, VAPI_API_KEY: "from-env" },
  });

  assert.equal(config.langfuse.publicKey, "pk-test");
  assert.equal(config.providers.vapi?.apiKey, "from-env");
});

test("missing Langfuse credentials fail at load, naming the env vars", async () => {
  const file = await writeConfig("bindings: []\n");
  await assert.rejects(
    () => loadConfig({ configPath: file, env: {} }),
    (error: unknown) =>
      error instanceof ConfigError && /LANGFUSE_PUBLIC_KEY/.test(error.message),
  );
});

test("a binding without its provider key fails at load, not mid-sync", async () => {
  const file = await writeConfig(`
bindings:
  - provider: retell
    agentId: agent_1
    prompt: voice/one
`);
  await assert.rejects(
    () => loadConfig({ configPath: file, env: ENV }),
    (error: unknown) =>
      error instanceof ConfigError && /RETELL_API_KEY/.test(error.message),
  );
});

test("a disabled binding does not require its provider key", async () => {
  const file = await writeConfig(`
bindings:
  - provider: retell
    agentId: agent_1
    prompt: voice/one
    enabled: false
`);
  const config = await loadConfig({ configPath: file, env: ENV });
  assert.equal(config.bindings.length, 1);
});

test("variables are rejected on any direction that can pull", async () => {
  const file = await writeConfig(`
bindings:
  - provider: vapi
    agentId: asst_1
    prompt: voice/one
    variables:
      company: Acme
`);
  await assert.rejects(
    () => loadConfig({ configPath: file, env: ENV }),
    (error: unknown) =>
      error instanceof ConfigError && /one-way/.test(error.message),
  );
});

test("variables are accepted on a push-only binding", async () => {
  const file = await writeConfig(`
bindings:
  - provider: vapi
    agentId: asst_1
    prompt: voice/one
    direction: langfuse-to-provider
    variables:
      company: Acme
`);
  const config = await loadConfig({ configPath: file, env: ENV });
  assert.equal(config.bindings[0]?.variables["company"], "Acme");
});

test("secrets can be referenced from the file via placeholders", async () => {
  const file = await writeConfig(`
providers:
  vapi:
    apiKey: \${MY_VAPI_KEY}
bindings:
  - provider: vapi
    agentId: asst_1
    prompt: voice/one
`);
  const config = await loadConfig({
    configPath: file,
    env: {
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      MY_VAPI_KEY: "resolved-key",
    },
  });
  assert.equal(config.providers.vapi?.apiKey, "resolved-key");
});

test("an explicitly named missing config file is an error", async () => {
  await assert.rejects(
    () => loadConfig({ configPath: "/nonexistent/nope.yaml", env: ENV }),
    (error: unknown) =>
      error instanceof ConfigError && /not found/.test(error.message),
  );
});

test("PORT and WEBHOOK_SECRET are read from the environment", async () => {
  const file = await writeConfig("bindings: []\n");
  const config = await loadConfig({
    configPath: file,
    env: { ...ENV, PORT: "9999", WEBHOOK_SECRET: "shh" },
  });
  assert.equal(config.server.port, 9999);
  assert.equal(config.server.webhookSecret, "shh");
});

test("findConfigFile walks up from a nested directory", async () => {
  const file = await writeConfig("bindings: []\n");
  const found = findConfigFile(path.dirname(file));
  assert.equal(found, file);
});

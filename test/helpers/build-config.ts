import type { AppConfig, Binding } from "../../src/config/load.js";

/** A fully-resolved config for tests, with sane defaults per binding. */
export function buildConfig(
  bindings: Array<Partial<Binding> & Pick<Binding, "provider" | "agentId" | "prompt">>,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    langfuse: {
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-test",
      secretKey: "sk-test",
    },
    providers: {
      retell: { apiKey: "retell-key" },
      elevenlabs: { apiKey: "elevenlabs-key" },
      vapi: { apiKey: "vapi-key" },
    },
    bindings: bindings.map((binding) => ({
      id: binding.id ?? `${binding.provider}:${binding.agentId}`,
      provider: binding.provider,
      agentId: binding.agentId,
      prompt: binding.prompt,
      label: binding.label ?? "production",
      tags: binding.tags ?? [],
      direction: binding.direction ?? "bidirectional",
      conflictPolicy: binding.conflictPolicy ?? "manual",
      syncFields: binding.syncFields ?? true,
      options: binding.options ?? {},
      variables: binding.variables ?? {},
      enabled: binding.enabled ?? true,
    })),
    state: { driver: "memory", path: ".test-state.json" },
    watch: { intervalSeconds: 60, jitter: 0 },
    server: { host: "127.0.0.1", port: 0 },
    logging: { level: "silent" },
    ...overrides,
  };
}

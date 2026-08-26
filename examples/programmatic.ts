/**
 * Using the package as a library instead of a CLI.
 *
 * Useful when the bindings are not static — for example when agents are
 * created per tenant and the list lives in your own database.
 */
import {
  createLogger,
  FileStateStore,
  LangfuseClient,
  SyncEngine,
  formatReport,
  type AppConfig,
} from "langfuse-voice-provider";

const config: AppConfig = {
  langfuse: {
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  },
  providers: {
    retell: { apiKey: process.env.RETELL_API_KEY! },
    vapi: { apiKey: process.env.VAPI_API_KEY! },
  },
  bindings: [
    {
      id: "support-line",
      provider: "retell",
      agentId: "agent_0123456789abcdef",
      prompt: "voice/support-line",
      label: "production",
      tags: ["voice"],
      direction: "bidirectional",
      conflictPolicy: "prefer-provider",
      syncFields: true,
      options: {},
      variables: {},
      enabled: true,
    },
  ],
  state: { driver: "file", path: "./state.json" },
  watch: { intervalSeconds: 60, jitter: 0.1 },
  server: { host: "0.0.0.0", port: 8080 },
  logging: { level: "info" },
};

const engine = new SyncEngine({
  config,
  logger: createLogger({ level: "info", format: "pretty" }),
  stateStore: new FileStateStore("./state.json"),
});

// See what would happen before committing to it.
const plan = await engine.run({ dryRun: true });
console.log(formatReport(plan));

if (plan.counts.conflict === 0) {
  const report = await engine.run();
  console.log(formatReport(report));
}

// The Langfuse client is usable on its own, e.g. to read the exact prompt
// version an agent is running so a trace can be attributed to it.
const langfuse = new LangfuseClient({
  baseUrl: config.langfuse.baseUrl,
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
});
const live = await langfuse.getPrompt("voice/support-line", { label: "production" });
console.log(`support-line is running v${live?.version}`);

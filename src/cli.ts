#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Command, Option } from "commander";
import { loadConfig, type AppConfig, type Binding } from "./config/load.js";
import { ConfigError, LangfuseVoiceError } from "./core/errors.js";
import { createLogger, type Logger, type LogLevel } from "./core/logger.js";
import { createProvider, isProviderName, PROVIDER_ENV_VARS, PROVIDER_NAMES } from "./providers/index.js";
import { SyncEngine, type RunOptions, type SyncReport } from "./sync/engine.js";
import { exitCodeFor, formatReport, toJson } from "./sync/report.js";
import { Watcher } from "./sync/watcher.js";
import { SyncServer } from "./server/server.js";
import type { ProviderName, SyncDirection } from "./types.js";

interface GlobalOptions {
  config?: string;
  logLevel?: LogLevel;
  json?: boolean;
}

const program = new Command();

program
  .name("langfuse-voice")
  .description(
    "Keep Retell, ElevenLabs and Vapi agent prompts in sync with Langfuse prompt management.",
  )
  .version("0.1.0")
  .option("-c, --config <path>", "path to the config file")
  .addOption(
    new Option("--log-level <level>", "log verbosity").choices([
      "debug",
      "info",
      "warn",
      "error",
      "silent",
    ]),
  )
  .option("--json", "emit machine-readable JSON instead of a text report", false);

program
  .command("sync")
  .description("Run one sync pass over every enabled binding")
  .option("--dry-run", "show what would change without writing anything", false)
  .option(
    "--only <ids...>",
    "limit the run to these binding ids, prompt names or agent ids",
  )
  .addOption(
    new Option("--direction <direction>", "override the configured direction").choices([
      "langfuse-to-provider",
      "provider-to-langfuse",
      "bidirectional",
    ]),
  )
  .addOption(
    new Option("--conflict <policy>", "override the conflict policy").choices([
      "prefer-langfuse",
      "prefer-provider",
      "manual",
    ]),
  )
  .action(async (options) => {
    const { config, logger, globals } = await bootstrap();
    applyConflictOverride(config, options.conflict);
    const engine = new SyncEngine({ config, logger });
    const report = await engine.run(buildRunOptions(options));
    emitReport(report, globals);
    process.exitCode = exitCodeFor(report);
  });

program
  .command("push")
  .description("Force Langfuse -> provider for the selected bindings")
  .option("--dry-run", "show what would change without writing anything", false)
  .option("--only <ids...>", "limit the run to these bindings")
  .action(async (options) => {
    await runDirectional("langfuse-to-provider", options);
  });

program
  .command("pull")
  .description("Force provider -> Langfuse for the selected bindings")
  .option("--dry-run", "show what would change without writing anything", false)
  .option("--only <ids...>", "limit the run to these bindings")
  .action(async (options) => {
    await runDirectional("provider-to-langfuse", options);
  });

program
  .command("status")
  .description("Report drift between Langfuse and each provider without writing")
  .option("--only <ids...>", "limit the check to these bindings")
  .action(async (options) => {
    const { config, logger, globals } = await bootstrap();
    const engine = new SyncEngine({ config, logger });
    const report = await engine.run({
      dryRun: true,
      ...(options.only ? { only: options.only } : {}),
    });
    emitReport(report, globals);
    // Drift is the answer to the question, not a failure of the command.
    process.exitCode = report.counts.error > 0 ? 1 : 0;
  });

program
  .command("watch")
  .description("Poll continuously and keep both sides converged")
  .option("--interval <seconds>", "override the configured poll interval")
  .option("--only <ids...>", "limit the loop to these bindings")
  .action(async (options) => {
    const { config, logger } = await bootstrap();
    const engine = new SyncEngine({ config, logger });
    const intervalSeconds = options.interval
      ? Number(options.interval)
      : config.watch.intervalSeconds;
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) {
      throw new ConfigError("--interval must be a number of seconds >= 5.");
    }
    const watcher = new Watcher({
      engine,
      intervalSeconds,
      jitter: config.watch.jitter,
      logger,
      ...(options.only ? { runOptions: { only: options.only } } : {}),
    });
    logger.info("watching", {
      intervalSeconds,
      bindings: config.bindings.filter((binding) => binding.enabled).length,
    });
    await watcher.start();
    await waitForShutdown(logger, () => watcher.stop());
  });

program
  .command("serve")
  .description("Run the HTTP server: health, metrics, and webhook-triggered syncs")
  .option("--port <port>", "override the configured port")
  .option("--no-watch", "serve without the background poll loop")
  .action(async (options) => {
    const { config, logger } = await bootstrap();
    const engine = new SyncEngine({ config, logger });
    const port = options.port ? Number(options.port) : config.server.port;
    if (!Number.isFinite(port)) throw new ConfigError("--port must be a number.");
    if (!config.server.webhookSecret) {
      logger.warn(
        "no webhook secret configured; /sync and /webhooks/* will reject every request. Set WEBHOOK_SECRET to enable them.",
      );
    }
    const server = new SyncServer({
      engine,
      host: config.server.host,
      port,
      ...(config.server.webhookSecret
        ? { webhookSecret: config.server.webhookSecret }
        : {}),
      ...(options.watch === false
        ? {}
        : {
            watch: {
              intervalSeconds: config.watch.intervalSeconds,
              jitter: config.watch.jitter,
            },
          }),
      logger,
    });
    await server.listen();
    await waitForShutdown(logger, () => server.close());
  });

program
  .command("list")
  .argument("[provider]", `one of: ${PROVIDER_NAMES.join(", ")}`)
  .description("List agents on a provider, to find the ids for your bindings")
  .action(async (providerName?: string) => {
    const { config, logger, globals } = await bootstrap();
    const names: ProviderName[] = providerName
      ? [assertProviderName(providerName)]
      : (Object.keys(config.providers) as ProviderName[]);

    if (names.length === 0) {
      throw new ConfigError(
        `No provider credentials found. Set one of: ${Object.values(PROVIDER_ENV_VARS).join(", ")}.`,
      );
    }

    const output: Record<string, unknown[]> = {};
    for (const name of names) {
      const credentials = config.providers[name];
      if (!credentials) {
        throw new ConfigError(
          `No API key for "${name}". Set ${PROVIDER_ENV_VARS[name]}.`,
        );
      }
      const provider = createProvider(name, {
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        logger,
      });
      const agents = await provider.listAgents();
      output[name] = agents;
      if (!globals.json) {
        process.stdout.write(`\n${name} (${agents.length} agent(s))\n`);
        for (const agent of agents) {
          const flag = agent.syncable ? " " : "!";
          const detail = agent.detail
            ? "  " +
              Object.entries(agent.detail)
                .map(([key, value]) => `${key}=${value}`)
                .join(" ")
            : "";
          process.stdout.write(`${flag} ${agent.id}  ${agent.name}${detail}\n`);
          if (!agent.syncable && agent.reason) {
            process.stdout.write(`    not syncable: ${agent.reason}\n`);
          }
        }
      }
    }
    if (globals.json) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  });

program
  .command("init")
  .description("Write a starter config file into the current directory")
  .option("-o, --output <path>", "where to write it", "langfuse-voice.config.yaml")
  .option("--force", "overwrite an existing file", false)
  .action(async (options) => {
    if (existsSync(options.output) && !options.force) {
      throw new ConfigError(
        `${options.output} already exists. Pass --force to overwrite it.`,
      );
    }
    await writeFile(options.output, STARTER_CONFIG, "utf8");
    process.stdout.write(
      `Wrote ${options.output}\n\nNext:\n` +
        `  1. export LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=...\n` +
        `  2. export RETELL_API_KEY=... (and/or ELEVENLABS_API_KEY, VAPI_API_KEY)\n` +
        `  3. langfuse-voice list retell        # find your agent ids\n` +
        `  4. edit ${options.output} to fill in bindings\n` +
        `  5. langfuse-voice sync --dry-run\n`,
    );
  });

program
  .command("validate")
  .description("Load and check the config without contacting any API")
  .action(async () => {
    const { config, globals } = await bootstrap();
    if (globals.json) {
      process.stdout.write(
        JSON.stringify(
          { sourcePath: config.sourcePath ?? null, bindings: config.bindings },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    process.stdout.write(
      `Config OK${config.sourcePath ? ` (${config.sourcePath})` : " (no file; env only)"}\n`,
    );
    process.stdout.write(
      `Langfuse: ${config.langfuse.baseUrl}\n` +
        `Providers: ${Object.keys(config.providers).join(", ") || "none"}\n` +
        `Bindings: ${config.bindings.length}\n`,
    );
    for (const binding of config.bindings) {
      process.stdout.write(
        `  ${binding.enabled ? " " : "-"} ${binding.id}: ${binding.provider}/${binding.agentId} <-> ` +
          `"${binding.prompt}"@${binding.label} [${binding.direction}, ${binding.conflictPolicy}]\n`,
      );
    }
  });

async function bootstrap(): Promise<{
  config: AppConfig;
  logger: Logger;
  globals: GlobalOptions;
}> {
  const globals = program.opts<GlobalOptions>();
  const config = await loadConfig(
    globals.config ? { configPath: globals.config } : {},
  );
  const level = globals.logLevel ?? config.logging.level;
  const logger = createLogger({
    level,
    ...(config.logging.format ? { format: config.logging.format } : {}),
  });
  return { config, logger, globals };
}

async function runDirectional(
  direction: SyncDirection,
  options: { dryRun?: boolean; only?: string[] },
): Promise<void> {
  const { config, logger, globals } = await bootstrap();
  const engine = new SyncEngine({ config, logger });
  const report = await engine.run({
    direction,
    dryRun: options.dryRun === true,
    ...(options.only ? { only: options.only } : {}),
  });
  emitReport(report, globals);
  process.exitCode = exitCodeFor(report);
}

function buildRunOptions(options: {
  dryRun?: boolean;
  only?: string[];
  direction?: SyncDirection;
}): RunOptions {
  return {
    dryRun: options.dryRun === true,
    ...(options.only ? { only: options.only } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
  };
}

/** `--conflict` is a per-run override applied to every binding. */
function applyConflictOverride(
  config: AppConfig,
  policy: Binding["conflictPolicy"] | undefined,
): void {
  if (!policy) return;
  for (const binding of config.bindings) binding.conflictPolicy = policy;
}

function emitReport(report: SyncReport, globals: GlobalOptions): void {
  process.stdout.write(
    (globals.json ? toJson(report) : formatReport(report)) + "\n",
  );
}

function assertProviderName(value: string): ProviderName {
  if (!isProviderName(value)) {
    throw new ConfigError(
      `Unknown provider "${value}". Expected one of: ${PROVIDER_NAMES.join(", ")}.`,
    );
  }
  return value;
}

/** Block until SIGINT/SIGTERM, then shut down cleanly. */
async function waitForShutdown(
  logger: Logger,
  onShutdown: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const handler = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("shutting down", { signal });
      void onShutdown()
        .catch((error) => {
          logger.error("shutdown failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(resolve);
    };
    process.once("SIGINT", () => handler("SIGINT"));
    process.once("SIGTERM", () => handler("SIGTERM"));
  });
}

const STARTER_CONFIG = `# langfuse-voice-provider
# Secrets come from the environment. Never commit API keys to this file.

langfuse:
  baseUrl: \${LANGFUSE_BASE_URL:-https://cloud.langfuse.com}

defaults:
  # bidirectional | langfuse-to-provider | provider-to-langfuse
  direction: bidirectional
  # manual | prefer-langfuse | prefer-provider
  conflictPolicy: manual
  label: production
  syncFields: true
  tags: [voice]

state:
  driver: file
  path: .langfuse-voice-state.json

watch:
  intervalSeconds: 60

bindings:
  # Run \`langfuse-voice list retell\` to find agent ids.
  # - id: support-line
  #   provider: retell
  #   agentId: agent_xxxxxxxxxxxxxxxx
  #   prompt: voice/support-line
  #   label: production
  #
  # - provider: elevenlabs
  #   agentId: agent_xxxxxxxxxxxxxxxx
  #   prompt: voice/onboarding
  #
  # - provider: vapi
  #   agentId: 00000000-0000-0000-0000-000000000000
  #   prompt: voice/outbound-qualifier
  #   direction: langfuse-to-provider
`;

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof LangfuseVoiceError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void main();

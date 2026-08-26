import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";
import { PROVIDER_ENV_VARS } from "../providers/index.js";
import type {
  ConflictPolicy,
  ProviderName,
  SyncDirection,
} from "../types.js";
import { configSchema, type ResolvedConfig } from "./schema.js";

/** File names searched, in order, when no `--config` is given. */
export const CONFIG_FILE_NAMES = [
  "langfuse-voice.config.yaml",
  "langfuse-voice.config.yml",
  "langfuse-voice.config.json",
  ".langfusevoicerc",
  ".langfusevoicerc.yaml",
  ".langfusevoicerc.json",
];

/** A binding with every default already applied. */
export interface Binding {
  id: string;
  provider: ProviderName;
  agentId: string;
  prompt: string;
  label: string;
  tags: string[];
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  syncFields: boolean;
  options: Record<string, string | number | boolean>;
  variables: Record<string, string>;
  enabled: boolean;
}

export interface AppConfig {
  langfuse: { baseUrl: string; publicKey: string; secretKey: string };
  providers: Partial<Record<ProviderName, { apiKey: string; baseUrl?: string }>>;
  bindings: Binding[];
  state: ResolvedConfig["state"];
  watch: ResolvedConfig["watch"];
  server: ResolvedConfig["server"];
  logging: ResolvedConfig["logging"];
  /** Absolute path the config was read from, if any. */
  sourcePath?: string;
}

/** Locate a config file by walking up from `cwd` to the filesystem root. */
export function findConfigFile(cwd = process.cwd()): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadConfigOptions {
  /** Explicit config path. When set, a missing file is an error. */
  configPath?: string;
  cwd?: string;
  /** Defaults to `process.env`; injected in tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Load, validate and resolve configuration.
 *
 * Precedence is env over file, because containers and CI inject secrets
 * through the environment and should never need the file edited to do it.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const sourcePath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : findConfigFile(cwd);

  if (options.configPath && !existsSync(sourcePath!)) {
    throw new ConfigError(`Config file not found: ${sourcePath}`);
  }

  const { raw, unresolved } = sourcePath
    ? await readConfigFile(sourcePath, env)
    : { raw: {}, unresolved: [] as string[] };
  const parsed = parseConfig(raw, sourcePath, unresolved);
  return resolveConfig(parsed, env, sourcePath);
}

/** Validate a plain object against the schema, with readable error output. */
export function parseConfig(
  raw: unknown,
  sourcePath?: string,
  unresolvedPlaceholders: string[] = [],
): ResolvedConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    // An unset `${VAR}` expands to nothing and reaches the schema as null,
    // which on its own reads as a baffling type error. Name the variable.
    const hint = unresolvedPlaceholders.length
      ? `\n\nNote: these placeholders resolved to nothing because the variables are unset: ` +
        `${unresolvedPlaceholders.join(", ")}.`
      : "";
    throw new ConfigError(
      `Invalid configuration${sourcePath ? ` in ${sourcePath}` : ""}:\n${formatZodError(
        result.error,
      )}${hint}`,
    );
  }
  return result.data;
}

async function readConfigFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ raw: unknown; unresolved: string[] }> {
  const text = await readFile(filePath, "utf8");
  const unresolved = findUnresolvedPlaceholders(text, env);
  const expanded = expandEnvPlaceholders(text, env);
  try {
    const raw = filePath.endsWith(".json")
      ? JSON.parse(expanded)
      : (parseYaml(expanded) ?? {});
    return { raw, unresolved };
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Placeholder names with neither an env value nor a fallback. */
function findUnresolvedPlaceholders(
  text: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
  )) {
    const name = match[1] as string;
    if (env[name] === undefined && match[2] === undefined) names.add(name);
  }
  return [...names];
}

/**
 * Substitute `${VAR}` and `${VAR:-fallback}` from the environment, so a config
 * file can be committed with references to secrets instead of the secrets.
 */
export function expandEnvPlaceholders(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => env[name] ?? fallback ?? "",
  );
}

function resolveConfig(
  parsed: ResolvedConfig,
  env: NodeJS.ProcessEnv,
  sourcePath?: string,
): AppConfig {
  const publicKey = env["LANGFUSE_PUBLIC_KEY"] ?? parsed.langfuse.publicKey;
  const secretKey = env["LANGFUSE_SECRET_KEY"] ?? parsed.langfuse.secretKey;
  const baseUrl =
    env["LANGFUSE_BASE_URL"] ?? env["LANGFUSE_HOST"] ?? parsed.langfuse.baseUrl;

  if (!publicKey || !secretKey) {
    throw new ConfigError(
      "Langfuse credentials are missing. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, " +
        "or langfuse.publicKey / langfuse.secretKey in the config file.",
    );
  }

  const providers: AppConfig["providers"] = {};
  for (const [name, envVar] of Object.entries(PROVIDER_ENV_VARS) as Array<
    [ProviderName, string]
  >) {
    const fromFile = parsed.providers[name];
    const apiKey = env[envVar] ?? fromFile?.apiKey;
    const providerBaseUrl =
      env[`${envVar.replace(/_API_KEY$/, "")}_BASE_URL`] ?? fromFile?.baseUrl;
    if (apiKey) {
      providers[name] = providerBaseUrl
        ? { apiKey, baseUrl: providerBaseUrl }
        : { apiKey };
    }
  }

  const seen = new Set<string>();
  const bindings: Binding[] = parsed.bindings.map((binding, index) => {
    const id = binding.id ?? `${binding.provider}:${binding.agentId}`;
    if (seen.has(id)) {
      throw new ConfigError(
        `Duplicate binding id "${id}" (bindings[${index}]). Give one of them an explicit \`id\`.`,
      );
    }
    seen.add(id);
    return {
      id,
      provider: binding.provider,
      agentId: binding.agentId,
      prompt: binding.prompt,
      label: binding.label ?? parsed.defaults.label,
      tags: [...new Set([...parsed.defaults.tags, ...binding.tags])],
      direction: binding.direction ?? parsed.defaults.direction,
      conflictPolicy: binding.conflictPolicy ?? parsed.defaults.conflictPolicy,
      syncFields: binding.syncFields ?? parsed.defaults.syncFields,
      options: binding.options,
      variables: binding.variables,
      enabled: binding.enabled,
    };
  });

  // Fail at load time rather than mid-sync on the first binding that needs it.
  for (const binding of bindings) {
    if (binding.enabled && !providers[binding.provider]) {
      throw new ConfigError(
        `Binding "${binding.id}" uses provider "${binding.provider}" but no API key was found. ` +
          `Set ${PROVIDER_ENV_VARS[binding.provider]} or providers.${binding.provider}.apiKey.`,
      );
    }
    // Substitution is one-way: a rendered prompt cannot be turned back into
    // the template it came from, so a binding that renders variables can only
    // ever push. Reject the combination instead of silently corrupting the
    // Langfuse template with rendered output on the first pull.
    if (
      Object.keys(binding.variables).length > 0 &&
      binding.direction !== "langfuse-to-provider"
    ) {
      throw new ConfigError(
        `Binding "${binding.id}" sets \`variables\` but its direction is "${binding.direction}". ` +
          `Rendering is one-way, so bindings with variables must use direction "langfuse-to-provider".`,
      );
    }
  }

  const config: AppConfig = {
    langfuse: { baseUrl, publicKey, secretKey },
    providers,
    bindings,
    state: parsed.state,
    watch: parsed.watch,
    server: {
      ...parsed.server,
      port: envInt(env["PORT"]) ?? parsed.server.port,
      webhookSecret: env["WEBHOOK_SECRET"] ?? parsed.server.webhookSecret,
    },
    logging: {
      level:
        (env["LOG_LEVEL"] as ResolvedConfig["logging"]["level"] | undefined) ??
        parsed.logging.level,
      format: parsed.logging.format,
    },
  };
  if (sourcePath) config.sourcePath = sourcePath;
  return config;
}

function envInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${location}: ${issue.message}`;
    })
    .join("\n");
}

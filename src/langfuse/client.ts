import { HttpClient } from "../core/http.js";
import { ConfigError } from "../core/errors.js";
import { silentLogger, type Logger } from "../core/logger.js";
import type { LangfusePrompt, PromptDocument } from "../types.js";

/**
 * Key under which this package stores its bookkeeping inside a Langfuse
 * prompt's `config` object. Everything else in `config` is left untouched, so
 * a prompt can carry unrelated application config alongside.
 */
export const CONFIG_NAMESPACE = "voiceProvider";

/** The shape stored under `config.voiceProvider`. */
export interface VoiceProviderConfig {
  provider: string;
  agentId: string;
  /** Provider-specific fields synced alongside the main prompt text. */
  fields?: Record<string, string>;
  /** Where the prompt was read from (Retell llm id, etc). */
  origin?: Record<string, string>;
  /** ISO timestamp of the sync that produced this version. */
  syncedAt?: string;
  /** Which side authored this version. */
  syncedFrom?: "langfuse" | "provider";
}

export interface LangfuseClientOptions {
  baseUrl?: string;
  publicKey: string;
  secretKey: string;
  logger?: Logger;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface CreatePromptInput {
  name: string;
  document: PromptDocument;
  labels?: string[];
  tags?: string[];
  commitMessage?: string;
  /** Merged over any config carried by the previous version. */
  config?: Record<string, unknown>;
}

export interface PromptMeta {
  name: string;
  versions: number[];
  labels: string[];
  tags: string[];
  lastUpdatedAt?: string;
}

interface RawPrompt {
  name: string;
  version: number;
  type?: "text" | "chat";
  prompt: unknown;
  labels?: string[];
  tags?: string[];
  commitMessage?: string | null;
  config?: unknown;
}

/**
 * Client for the Langfuse prompt-management API.
 *
 * Deliberately narrow: this package only ever reads a prompt version and
 * appends new ones. Langfuse prompt versions are immutable, which is exactly
 * the property that makes them a usable audit log for voice-agent prompts.
 */
export class LangfuseClient {
  private readonly http: HttpClient;
  private readonly logger: Logger;

  constructor(options: LangfuseClientOptions) {
    if (!options.publicKey || !options.secretKey) {
      throw new ConfigError(
        "Langfuse publicKey and secretKey are required (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY).",
      );
    }
    const auth = Buffer.from(
      `${options.publicKey}:${options.secretKey}`,
      "utf8",
    ).toString("base64");
    this.logger = options.logger ?? silentLogger;
    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? "https://cloud.langfuse.com",
      headers: { authorization: `Basic ${auth}` },
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      logger: this.logger.child({ component: "langfuse" }),
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
  }

  /**
   * Fetch one prompt. Returns `null` when the prompt (or the requested
   * label/version) does not exist yet — the normal state before the first sync.
   */
  async getPrompt(
    name: string,
    selector: { label?: string; version?: number } = {},
  ): Promise<LangfusePrompt | null> {
    const raw = await this.http.request<RawPrompt>({
      method: "GET",
      path: `/api/public/v2/prompts/${encodeURIComponent(name)}`,
      query: { label: selector.label, version: selector.version },
      allow404: true,
    });
    return raw ? toLangfusePrompt(raw) : null;
  }

  /**
   * Append a new version of a prompt. Langfuse has no update endpoint: every
   * write is a new immutable version, and labels move to point at it.
   */
  async createPromptVersion(input: CreatePromptInput): Promise<LangfusePrompt> {
    const body: Record<string, unknown> = {
      name: input.name,
      type: "text",
      prompt: input.document.text,
      config: input.config ?? {},
    };
    if (input.labels?.length) body["labels"] = input.labels;
    if (input.tags?.length) body["tags"] = input.tags;
    if (input.commitMessage) body["commitMessage"] = input.commitMessage;

    const raw = await this.http.request<RawPrompt>({
      method: "POST",
      path: "/api/public/v2/prompts",
      body,
    });
    this.logger.debug("created prompt version", {
      name: input.name,
      version: raw.version,
    });
    return toLangfusePrompt(raw);
  }

  /** List prompt names with their versions and labels. Handles pagination. */
  async listPrompts(
    filter: { name?: string; label?: string; tag?: string } = {},
  ): Promise<PromptMeta[]> {
    const out: PromptMeta[] = [];
    let page = 1;
    // Bounded so a misbehaving server cannot spin this forever.
    for (; page <= 100; page++) {
      const response = await this.http.request<{
        data?: PromptMeta[];
        meta?: { totalPages?: number };
      }>({
        method: "GET",
        path: "/api/public/v2/prompts",
        query: { ...filter, page, limit: 100 },
      });
      const data = response?.data ?? [];
      out.push(...data);
      const totalPages = response?.meta?.totalPages ?? 1;
      if (data.length === 0 || page >= totalPages) break;
    }
    return out;
  }
}

/**
 * Read the package's bookkeeping out of a Langfuse prompt config, tolerating
 * prompts that were created by hand and carry no bookkeeping at all.
 */
export function readVoiceConfig(
  prompt: LangfusePrompt | null,
): VoiceProviderConfig | null {
  const raw = prompt?.config?.[CONFIG_NAMESPACE];
  if (!raw || typeof raw !== "object") return null;
  return raw as VoiceProviderConfig;
}

function toLangfusePrompt(raw: RawPrompt): LangfusePrompt {
  const config = (
    raw.config && typeof raw.config === "object" ? raw.config : {}
  ) as Record<string, unknown>;
  const voice = config[CONFIG_NAMESPACE] as VoiceProviderConfig | undefined;
  return {
    name: raw.name,
    version: raw.version,
    type: raw.type === "chat" ? "chat" : "text",
    document: {
      text: extractText(raw),
      fields: voice?.fields ?? {},
    },
    labels: raw.labels ?? [],
    tags: raw.tags ?? [],
    commitMessage: raw.commitMessage ?? null,
    config,
  };
}

/**
 * Voice prompts are written as Langfuse text prompts, but a user may point a
 * binding at a chat prompt they already maintain. Fold a chat prompt down to
 * the text a voice agent can actually accept: the system turns, joined.
 */
function extractText(raw: RawPrompt): string {
  if (typeof raw.prompt === "string") return raw.prompt;
  if (Array.isArray(raw.prompt)) {
    return raw.prompt
      .filter(
        (message): message is { role?: string; content?: string } =>
          typeof message === "object" && message !== null,
      )
      .filter((message) => (message.role ?? "system") === "system")
      .map((message) => message.content ?? "")
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

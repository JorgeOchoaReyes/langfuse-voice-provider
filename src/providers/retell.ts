import { HttpClient } from "../core/http.js";
import { UnsupportedAgentError } from "../core/errors.js";
import { silentLogger, type Logger } from "../core/logger.js";
import type {
  AgentSummary,
  PromptDocument,
  ProviderTarget,
  RemotePrompt,
  VoiceProvider,
} from "../types.js";

export interface RetellProviderOptions {
  apiKey: string;
  baseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
}

interface RetellAgent {
  agent_id: string;
  agent_name?: string | null;
  version?: number;
  response_engine?:
    | { type: "retell-llm"; llm_id: string; version?: number }
    | { type: "custom-llm"; llm_websocket_url?: string }
    | { type: "conversation-flow"; conversation_flow_id: string; version?: number };
}

interface RetellLlm {
  llm_id: string;
  version?: number;
  general_prompt?: string | null;
  begin_message?: string | null;
  states?: Array<{ name: string; state_prompt?: string }> | null;
}

/** Prefix used to flatten Retell's multi-prompt state machine into `fields`. */
const STATE_FIELD_PREFIX = "state:";

/**
 * Retell adapter.
 *
 * Retell splits an agent from its response engine: the prompt does not live on
 * the agent, it lives on the Retell LLM the agent points at. Agents backed by a
 * custom LLM or a conversation flow have no single prompt for us to own, and
 * are reported as unsyncable rather than silently skipped.
 */
export class RetellProvider implements VoiceProvider {
  readonly name = "retell" as const;
  readonly supportedFields = ["beginMessage"] as const;

  private readonly http: HttpClient;
  private readonly logger: Logger;

  constructor(options: RetellProviderOptions) {
    this.logger = options.logger ?? silentLogger;
    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? "https://api.retellai.com",
      headers: { authorization: `Bearer ${options.apiKey}` },
      logger: this.logger.child({ provider: "retell" }),
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
  }

  async listAgents(): Promise<AgentSummary[]> {
    const agents = await this.http.request<RetellAgent[]>({
      method: "POST",
      path: "/v2/list-agents",
      query: { limit: 1000 },
      body: {},
    });
    return (agents ?? []).map((agent) => {
      const engine = agent.response_engine;
      const syncable = engine?.type === "retell-llm";
      const summary: AgentSummary = {
        id: agent.agent_id,
        name: agent.agent_name ?? agent.agent_id,
        syncable,
        detail: { engine: engine?.type ?? "unknown" },
      };
      if (engine?.type === "retell-llm") {
        summary.detail = { ...summary.detail, llmId: engine.llm_id };
      } else {
        summary.reason = `response engine "${engine?.type ?? "unknown"}" has no single prompt to sync`;
      }
      return summary;
    });
  }

  async getPrompt(target: ProviderTarget): Promise<RemotePrompt> {
    const { llm, llmId } = await this.resolveLlm(target);
    const fields: Record<string, string> = {};
    if (llm.begin_message) fields["beginMessage"] = llm.begin_message;
    for (const state of llm.states ?? []) {
      if (state?.name && typeof state.state_prompt === "string") {
        fields[`${STATE_FIELD_PREFIX}${state.name}`] = state.state_prompt;
      }
    }
    return {
      document: { text: llm.general_prompt ?? "", fields },
      origin: {
        agentId: target.agentId,
        llmId,
        ...(llm.version !== undefined ? { llmVersion: String(llm.version) } : {}),
      },
    };
  }

  async setPrompt(
    target: ProviderTarget,
    document: PromptDocument,
  ): Promise<void> {
    const { llm, llmId, version } = await this.resolveLlm(target);

    const body: Record<string, unknown> = { general_prompt: document.text };
    if (typeof document.fields["beginMessage"] === "string") {
      body["begin_message"] = document.fields["beginMessage"];
    }

    // States are replaced as a whole array, so start from what Retell has and
    // overwrite only the prompts we are responsible for. Dropping a state we
    // did not author would delete conversation logic.
    const states = llm.states ?? [];
    if (states.length > 0) {
      const next = states.map((state) => {
        const incoming = document.fields[`${STATE_FIELD_PREFIX}${state.name}`];
        return typeof incoming === "string"
          ? { ...state, state_prompt: incoming }
          : state;
      });
      const changed = next.some(
        (state, index) => state.state_prompt !== states[index]?.state_prompt,
      );
      if (changed) body["states"] = next;
    }

    await this.http.request({
      method: "PATCH",
      path: `/update-retell-llm/${encodeURIComponent(llmId)}`,
      query: version !== undefined ? { version } : undefined,
      body,
    });
    this.logger.debug("updated retell llm", { llmId, agentId: target.agentId });
  }

  /**
   * Resolve the Retell LLM behind an agent. `llmId` can be supplied directly in
   * the binding options to skip the agent lookup entirely.
   */
  private async resolveLlm(
    target: ProviderTarget,
  ): Promise<{ llm: RetellLlm; llmId: string; version?: number }> {
    const configuredVersion = coerceVersion(target.options?.["llmVersion"]);
    const configuredLlmId = target.options?.["llmId"];

    let llmId: string;
    let version = configuredVersion;

    if (typeof configuredLlmId === "string" && configuredLlmId.length > 0) {
      llmId = configuredLlmId;
    } else {
      const agent = await this.http.request<RetellAgent>({
        method: "GET",
        path: `/get-agent/${encodeURIComponent(target.agentId)}`,
        query: { version: coerceVersion(target.options?.["agentVersion"]) },
      });
      const engine = agent?.response_engine;
      if (engine?.type !== "retell-llm") {
        throw new UnsupportedAgentError(
          `Retell agent ${target.agentId} uses response engine "${
            engine?.type ?? "unknown"
          }". Only "retell-llm" agents expose a prompt this package can sync. ` +
            `Point the binding at a retell-llm agent, or set options.llmId explicitly.`,
        );
      }
      llmId = engine.llm_id;
      version = version ?? engine.version;
    }

    const llm = await this.http.request<RetellLlm>({
      method: "GET",
      path: `/get-retell-llm/${encodeURIComponent(llmId)}`,
      query: version !== undefined ? { version } : undefined,
    });
    return { llm, llmId, version };
  }
}

function coerceVersion(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

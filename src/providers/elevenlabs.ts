import { HttpClient } from "../core/http.js";
import { silentLogger, type Logger } from "../core/logger.js";
import type {
  AgentSummary,
  PromptDocument,
  ProviderTarget,
  RemotePrompt,
  VoiceProvider,
} from "../types.js";

export interface ElevenLabsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
}

interface ElevenLabsAgent {
  agent_id: string;
  name?: string | null;
  conversation_config?: {
    agent?: {
      prompt?: { prompt?: string | null } | null;
      first_message?: string | null;
    } | null;
  } | null;
}

interface ElevenLabsAgentPage {
  agents?: Array<{ agent_id: string; name?: string | null }>;
  next_cursor?: string | null;
  has_more?: boolean;
}

/**
 * ElevenLabs Conversational AI adapter.
 *
 * The prompt sits at `conversation_config.agent.prompt.prompt`. Updates are
 * read-modify-write: we PATCH the full `conversation_config` we just read with
 * only our keys changed, so unrelated voice, ASR and turn settings survive
 * regardless of how the API merges partial payloads.
 */
export class ElevenLabsProvider implements VoiceProvider {
  readonly name = "elevenlabs" as const;
  readonly supportedFields = ["firstMessage"] as const;

  private readonly http: HttpClient;
  private readonly logger: Logger;

  constructor(options: ElevenLabsProviderOptions) {
    this.logger = options.logger ?? silentLogger;
    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? "https://api.elevenlabs.io",
      headers: { "xi-api-key": options.apiKey },
      logger: this.logger.child({ provider: "elevenlabs" }),
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
  }

  async listAgents(): Promise<AgentSummary[]> {
    const out: AgentSummary[] = [];
    let cursor: string | undefined;
    // Bounded: 100 pages of 100 is far past any realistic workspace.
    for (let page = 0; page < 100; page++) {
      const response = await this.http.request<ElevenLabsAgentPage>({
        method: "GET",
        path: "/v1/convai/agents",
        query: { page_size: 100, cursor },
      });
      for (const agent of response?.agents ?? []) {
        out.push({
          id: agent.agent_id,
          name: agent.name ?? agent.agent_id,
          syncable: true,
        });
      }
      if (!response?.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }
    return out;
  }

  async getPrompt(target: ProviderTarget): Promise<RemotePrompt> {
    const agent = await this.fetchAgent(target.agentId);
    const agentConfig = agent.conversation_config?.agent ?? {};
    const fields: Record<string, string> = {};
    if (agentConfig.first_message) {
      fields["firstMessage"] = agentConfig.first_message;
    }
    return {
      document: { text: agentConfig.prompt?.prompt ?? "", fields },
      origin: { agentId: target.agentId },
    };
  }

  async setPrompt(
    target: ProviderTarget,
    document: PromptDocument,
  ): Promise<void> {
    const agent = await this.fetchAgent(target.agentId);
    const conversationConfig = agent.conversation_config ?? {};
    const agentConfig = conversationConfig.agent ?? {};

    const nextAgentConfig: Record<string, unknown> = {
      ...agentConfig,
      prompt: { ...(agentConfig.prompt ?? {}), prompt: document.text },
    };
    if (typeof document.fields["firstMessage"] === "string") {
      nextAgentConfig["first_message"] = document.fields["firstMessage"];
    }

    const body: Record<string, unknown> = {
      conversation_config: { ...conversationConfig, agent: nextAgentConfig },
    };
    const versionDescription = target.options?.["versionDescription"];
    if (typeof versionDescription === "string" && versionDescription) {
      body["version_description"] = versionDescription;
    }

    await this.http.request({
      method: "PATCH",
      path: `/v1/convai/agents/${encodeURIComponent(target.agentId)}`,
      body,
    });
    this.logger.debug("updated elevenlabs agent", { agentId: target.agentId });
  }

  private async fetchAgent(agentId: string): Promise<ElevenLabsAgent> {
    return this.http.request<ElevenLabsAgent>({
      method: "GET",
      path: `/v1/convai/agents/${encodeURIComponent(agentId)}`,
    });
  }
}
